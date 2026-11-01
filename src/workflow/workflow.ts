// ABOUTME: Coordinates spec & design, coding, and evaluation transitions for Trello work items.
import { runStageAgent, type StageAgentResult } from "../stageAgent/runStageAgent.js";
import {
  CONTAINER_WORKSPACE,
  runSpecDesignAgent,
  type SpecDesignRequest,
} from "../specDesignAgent/runSpecDesignAgent.js";
import { resolveSpecRequest, SpecRequestError } from "./specRequestFromCard.js";
import { routeSpecResult } from "./specRouting.js";
import { prepareSpecWorkspace, readCommittedWorkspaceFile, verifySpecBranchPublished } from "./specWorkspace.js";
import {
  commentOnCard,
  getCard,
  getCardComments,
  getWorkflowListId,
  getWorkflowStageLabel,
  moveCard,
  updateCardDescription,
  type TrelloCard,
  type TrelloComment,
} from "../trello/client.js";
import { config } from "../config.js";
import { isUnderWipLimit } from "./wip.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { activeFreezeForCard, readFreezeProjection, writeFreezeProjection, type FreezeTuple } from "./freezeState.js";
import { frozenArtifactSha256 } from "./specRequestFromCard.js";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { parse as parseYaml } from "yaml";
import { validateWorkContractV3 } from "./workContractV3.js";
import { loadAcceptedExecutionContract } from "./acceptedExecutionContract.js";
import { createGitHubAppReadToken } from "../githubApp.js";
import { latestStageRun, machineRecordComment, parseMachineRecord, type StageRun } from "./stageRecords.js";
import {
  buildEvaluationInvocation,
  buildReworkInvocation,
  comparePolicyEvidence,
  compareRequiredValidation,
  isRework,
  routeEvaluation,
  stageResultDecision,
  verifyPushedPackage,
  workContractRef,
  type PackageReads,
} from "./evaluationStage.js";
import { readBranchTip, readCommitParents, readFileAtCommit } from "./githubRead.js";

const lifecycleValidator = createLifecycleValidator(config.lifecycleSchemaPath);

export interface MoveApproval {
  approvedBy: string;
  approvedAt: string;
  eventId?: string;
}

/** Work queued for the Coding Agent: a newly accepted spec, or rework after a failed evaluation. */
type ExecutionJob =
  | {
      kind: "accepted";
      cardId: string;
      acceptance: Record<string, unknown>;
      workspaceRef: string;
      targetCommit: string;
      freezeActivation: Record<string, unknown>;
    }
  | { kind: "rework"; cardId: string; invocation: Record<string, unknown> };

const pendingQueue: ExecutionJob[] = [];
const pendingReviewQueue: Array<{ cardId: string; eventId: string }> = [];
const pendingSpecQueue: Array<{ cardId: string; approval: MoveApproval }> = [];
const manualSpecMarker = "<!-- agentic-sdlc-manual-spec-kickoff ";
let processing = false;
let reviewing = false;
let specing = false;

function enqueueCard(job: ExecutionJob): void {
  if (!pendingQueue.some((entry) => entry.cardId === job.cardId)) pendingQueue.push(job);
  void drainQueue();
}

function enqueueReview(cardId: string, eventId: string): void {
  if (!pendingReviewQueue.some((entry) => entry.cardId === cardId)) pendingReviewQueue.push({ cardId, eventId });
  void drainReviewQueue();
}

function enqueueSpec(cardId: string, approval: MoveApproval): void {
  if (!pendingSpecQueue.some((entry) => entry.cardId === cardId)) {
    pendingSpecQueue.push({ cardId, approval });
  }
  void drainSpecQueue();
}

async function drainSpecQueue(): Promise<void> {
  if (specing) return;
  specing = true;
  try {
    while (pendingSpecQueue.length > 0) {
      const next = pendingSpecQueue.shift()!;
      await processSpecCard(next.cardId, next.approval);
    }
  } finally {
    specing = false;
  }
}

async function drainReviewQueue(): Promise<void> {
  if (reviewing) return;
  reviewing = true;
  try {
    while (pendingReviewQueue.length > 0) {
      const next = pendingReviewQueue.shift()!;
      await evaluateCard(next.cardId, next.eventId).catch(async (err: unknown) => {
        console.error(`[trello-orchestrator] Evaluation failed for card ${next.cardId}:`, err);
        await commentOnCard(
          next.cardId,
          `❌ Evaluation could not be completed: ${err instanceof Error ? err.message : String(err)}. The card stays in ${getWorkflowStageLabel("evaluation")} for human triage.`,
        ).catch(() => undefined);
      });
    }
  } finally {
    reviewing = false;
  }
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (pendingQueue.length > 0) {
      if (!(await isUnderWipLimit(pendingQueue[0].cardId))) return;
      const job = pendingQueue.shift()!;
      await processCard(job).catch(async (err: unknown) => {
        console.error(`[trello-orchestrator] Execution failed for card ${job.cardId}:`, err);
        await commentOnCard(
          job.cardId,
          `❌ Execution could not be completed: ${err instanceof Error ? err.message : String(err)}. The card stays in ${getWorkflowStageLabel("execution")} for human triage.`,
        ).catch(() => undefined);
      });
    }
  } finally {
    processing = false;
  }
}

/** Read-only GitHub lookups on the product repository, with a freshly minted read token. */
async function productReads(repositoryUrl: string): Promise<PackageReads> {
  const token = await createGitHubAppReadToken({
    appId: config.orchestratorGithubAppId,
    installationId: config.orchestratorGithubAppInstallationId,
    privateKeyFile: config.orchestratorGithubAppPrivateKeyFile,
    repositoryUrl,
  });
  const github = { repositoryUrl, apiBase: config.intentBacklogApiBase, token };
  return {
    branchTip: (branch) => readBranchTip({ ...github, branch }),
    fileAt: (commit, path) => readFileAtCommit({ ...github, commit, path }),
    parentsOf: (commit) => readCommitParents({ ...github, commit }),
  };
}

/** Shared rule: a result is routed only while the freeze that authorized its invocation is still the active one. */
function freezeStillActive(card: TrelloCard, invocation: Record<string, unknown>): boolean {
  const active = activeFreezeForCard(card);
  return !!active && active.tuple.freezeEventId === (invocation.freeze_activation as Record<string, unknown>).event_id;
}

function acceptedDecisionFor(comments: TrelloComment[], invocationId: unknown): boolean {
  return comments.some((comment) => {
    const decision = parseMachineRecord(comment.data?.text ?? "", "stage-result-decision");
    return decision !== null && decision.invocation_id === invocationId && decision.disposition === "accepted";
  });
}

/** Rework runs already made under this freeze; the cap keeps a stubborn defect from looping forever. */
function reworkCount(comments: TrelloComment[], freezeEventId: unknown): number {
  return comments
    .map((comment) => parseMachineRecord(comment.data?.text ?? "", "stage-invocation"))
    .filter(
      (record): record is Record<string, unknown> =>
        record !== null &&
        record.stage === "execution" &&
        lifecycleValidator.validate("StageInvocation", record).valid &&
        (record.freeze_activation as Record<string, unknown>).event_id === freezeEventId &&
        isRework(record),
    ).length;
}

async function recordDecision(
  cardId: string,
  run: StageRun,
  result: Record<string, unknown>,
  issues: string[],
): Promise<boolean> {
  const decision = stageResultDecision({
    run,
    result,
    disposition: issues.length ? "rejected" : "accepted",
    recordedAt: new Date().toISOString(),
    ...(issues.length ? { reason: issues.join(" ") } : {}),
  });
  const validation = lifecycleValidator.validate("StageResultDecision", decision);
  if (!validation.valid) throw new Error(`StageResultDecision is invalid: ${validation.errors.join("; ")}`);
  const note = issues.length
    ? `StageResultDecision: **rejected**. ${issues.join(" ")}`
    : "StageResultDecision: **accepted**; the result and its pushed package were verified read-only on GitHub.";
  await commentOnCard(cardId, machineRecordComment("stage-result-decision", decision, note));
  return issues.length === 0;
}

/** Validates a worker's StageResult and its correlation to the invocation that produced it. */
function correlatedResult(
  run: StageAgentResult,
  invocation: Record<string, unknown>,
  stage: "execution" | "evaluation",
): { result: Record<string, unknown> | null; problem: string | null } {
  if (!run.stageResult) return { result: null, problem: run.error ?? "the finished run had no stage_result" };
  const validation = lifecycleValidator.validate("StageResult", run.stageResult);
  if (!validation.valid) return { result: null, problem: validation.errors.join("; ") };
  if (
    run.stageResult.invocation_id !== invocation.invocation_id ||
    run.stageResult.stage !== stage ||
    !isDeepStrictEqual(run.stageResult.work_item, invocation.work_item)
  ) {
    return { result: null, problem: "its invocation identity did not match" };
  }
  return { result: run.stageResult, problem: null };
}

function findingLines(result: Record<string, unknown>): string {
  const findings = Array.isArray(result.findings) ? (result.findings as unknown[]).map(String) : [];
  return findings.length
    ? `\n\n**Findings**\n${findings
        .slice(0, 15)
        .map((f) => `- ${f}`)
        .join("\n")}`
    : "";
}

async function processCard(job: ExecutionJob): Promise<void> {
  const { cardId } = job;
  const card = await getCard(cardId);
  console.log(`[trello-orchestrator] Processing card ${card.idShort} "${card.name}"`);
  if (card.idList !== getWorkflowListId("execution")) {
    await commentOnCard(cardId, "Execution was not started: the card no longer resides in Execution.");
    return;
  }

  let invocation: Record<string, unknown>;
  if (job.kind === "accepted") {
    try {
      const loaded = await loadAcceptedExecutionContract({
        card,
        acceptance: job.acceptance,
        workspaceRef: job.workspaceRef,
        targetCommit: job.targetCommit,
        intentBacklogApiBase: config.intentBacklogApiBase,
        intentBacklogReadToken: config.intentBacklogReadToken,
        createProductRepositoryReadToken: (repositoryUrl) =>
          createGitHubAppReadToken({
            appId: config.orchestratorGithubAppId,
            installationId: config.orchestratorGithubAppInstallationId,
            privateKeyFile: config.orchestratorGithubAppPrivateKeyFile,
            repositoryUrl,
          }),
        freezeActivation: job.freezeActivation,
        validator: lifecycleValidator,
      });
      invocation = loaded.invocation;
    } catch (err) {
      if (err instanceof Error) {
        await commentOnCard(cardId, `⚠️ Trello Orchestrator could not build a Work Contract:\n\n${err.message}`);
        return;
      }
      throw err;
    }
  } else {
    invocation = job.invocation;
  }
  await runExecution(card, invocation, job.kind === "rework");
}

/** Runs one Execution invocation, verifies the pushed candidate, and moves a verified candidate to Evaluation. */
async function runExecution(card: TrelloCard, invocation: Record<string, unknown>, rework: boolean): Promise<void> {
  const cardId = card.id;
  const invocationValidation = lifecycleValidator.validate("StageInvocation", invocation);
  if (!invocationValidation.valid) {
    await commentOnCard(
      cardId,
      `❌ Execution was not started because its StageInvocation is invalid: ${invocationValidation.errors.join("; ")}`,
    );
    return;
  }
  await commentOnCard(
    cardId,
    machineRecordComment("stage-invocation", invocation, "Validated Execution StageInvocation recorded."),
  );
  const workItemId = String((invocation.work_item as Record<string, unknown>).intent_id ?? "");
  await commentOnCard(
    cardId,
    `🤖 Coding Agent started (work item \`${workItemId}\`)${rework ? " to rework the findings of the failed evaluation" : ""}.`,
  );

  const coding = await runStageAgent(invocation, {
    serviceName: "Coding Agent",
    endpoint: config.codingAgentApiUrl,
    token: config.codingAgentApiToken,
    pollIntervalMs: config.codingAgentPollIntervalMs,
    timeoutMs: config.codingAgentTimeoutMs,
  });
  const { result, problem } = correlatedResult(coding, invocation, "execution");
  if (!result) {
    await commentOnCard(
      cardId,
      `❌ Coding Agent result was not usable: ${problem}. Needs human investigation.\n\n${coding.rawOutput.slice(-1500)}`,
    );
    return;
  }
  await commentOnCard(
    cardId,
    machineRecordComment("stage-result", result, "Validated Execution StageResult recorded."),
  );
  const status = String(result.status);
  await commentOnCard(
    cardId,
    `🤖 Coding Agent finished: **${status}**\n\n${String(result.summary ?? "(no summary)")}${findingLines(result)}`,
  );
  if (status !== "candidate_complete") {
    await commentOnCard(
      cardId,
      `⏸️ Only a \`candidate_complete\` result goes to Evaluation. The card stays in ${getWorkflowStageLabel("execution")} for the accountable human.`,
    );
    return;
  }

  const run: StageRun = { invocation, result };
  const evidenceRef = (result.output_artifacts as Record<string, unknown>[])[0];
  const target = invocation.target as Record<string, unknown>;
  const reads = await productReads(String(target.repository));
  const { pkg, issues } = await verifyPushedPackage({
    ref: evidenceRef,
    branch: String(invocation.workspace_ref),
    handoff: String(target.commit_sha),
    definition: "EvidencePackage",
    reads,
    validator: lifecycleValidator,
  });
  if (pkg && !issues.length) {
    if (!isDeepStrictEqual(pkg.candidate, result.candidate)) {
      issues.push("The Evidence Package names a different candidate than the StageResult.");
    }
    const contractRef = workContractRef(invocation);
    const contract = parseYaml(
      (await reads.fileAt(String(contractRef.commit_sha), String(contractRef.path))).toString("utf8"),
    ) as { required_validation?: { name: string }[]; policy_controls?: { control_id: string }[] };
    issues.push(
      ...compareRequiredValidation(
        contract.required_validation ?? [],
        (pkg.validation as Record<string, unknown>[]) ?? [],
        "The Evidence Package",
      ),
      ...comparePolicyEvidence(
        contract.policy_controls ?? [],
        (pkg.policy_control_evidence as Record<string, unknown>[]) ?? [],
      ),
    );
  }
  if (!freezeStillActive(await getCard(cardId), invocation)) {
    issues.push("The freeze that authorized this run is no longer active; the result is superseded.");
  }
  if (!(await recordDecision(cardId, run, evidenceRef, issues))) {
    await commentOnCard(cardId, `⏸️ The candidate was not sent to Evaluation. The card stays in Execution for triage.`);
    return;
  }
  await commentOnCard(
    cardId,
    `🔎 Candidate \`${String((result.candidate as Record<string, unknown>).commit_sha)}\` verified. Moving to ${getWorkflowStageLabel("evaluation")} for independent evaluation.`,
  );
  await moveCard(cardId, getWorkflowListId("evaluation"));
}

/** Runs the independent Evaluator on the newest verified candidate and routes its verified result. */
async function evaluateCard(cardId: string, eventId: string): Promise<void> {
  const card = await getCard(cardId);
  if (card.idList !== getWorkflowListId("evaluation")) return;
  const comments = await getCardComments(cardId);
  const execution = latestStageRun(comments, "execution", cardId, lifecycleValidator);
  if (!execution || execution.result.status !== "candidate_complete") {
    await commentOnCard(
      cardId,
      `⚠️ ${getWorkflowStageLabel("evaluation")} was entered without a candidate_complete Execution result. No evaluation was started.`,
    );
    return;
  }
  if (!acceptedDecisionFor(comments, execution.result.invocation_id)) {
    await commentOnCard(
      cardId,
      "⚠️ The newest candidate has no accepted StageResultDecision. No evaluation was started.",
    );
    return;
  }
  if (!freezeStillActive(card, execution.invocation)) {
    await commentOnCard(
      cardId,
      "⚠️ The freeze behind the newest candidate is no longer active. No evaluation was started.",
    );
    return;
  }

  const invocation = buildEvaluationInvocation(execution, eventId);
  const invocationValidation = lifecycleValidator.validate("StageInvocation", invocation);
  if (!invocationValidation.valid) {
    await commentOnCard(
      cardId,
      `❌ Evaluation was not started because its StageInvocation is invalid: ${invocationValidation.errors.join("; ")}`,
    );
    return;
  }
  await commentOnCard(
    cardId,
    machineRecordComment("stage-invocation", invocation, "Validated Evaluation StageInvocation recorded."),
  );
  await commentOnCard(
    cardId,
    `🔎 Independent Evaluator started on candidate \`${String((execution.result.candidate as Record<string, unknown>).commit_sha)}\`.`,
  );

  const evaluated = await runStageAgent(invocation, {
    serviceName: "Evaluator",
    endpoint: config.evaluatorApiUrl,
    token: config.evaluatorApiToken,
    pollIntervalMs: config.evaluatorPollIntervalMs,
    timeoutMs: config.evaluatorTimeoutMs,
  });
  const { result, problem } = correlatedResult(evaluated, invocation, "evaluation");
  if (!result) {
    await commentOnCard(
      cardId,
      `❌ Evaluator result was not usable: ${problem}. The card stays in ${getWorkflowStageLabel("evaluation")} for investigation.\n\n${evaluated.rawOutput.slice(-1500)}`,
    );
    return;
  }
  await commentOnCard(
    cardId,
    machineRecordComment("stage-result", result, "Validated Evaluation StageResult recorded."),
  );
  const status = String(result.status);
  await commentOnCard(
    cardId,
    `🔎 Evaluator finished: **${status.toUpperCase()}**\n\n${String(result.summary ?? "(no summary)")}${findingLines(result)}`,
  );
  if (!["pass", "fail", "needs_decision"].includes(status)) {
    await commentOnCard(
      cardId,
      `⏸️ \`${status}\` stays in ${getWorkflowStageLabel("evaluation")} for an authorized human resolution.`,
    );
    return;
  }

  const run: StageRun = { invocation, result };
  const packageRef = (result.output_artifacts as Record<string, unknown>[])[0];
  const target = invocation.target as Record<string, unknown>;
  const reads = await productReads(String(target.repository));
  const { pkg, issues } = await verifyPushedPackage({
    ref: packageRef,
    branch: String(invocation.workspace_ref),
    handoff: String(target.commit_sha),
    definition: "EvaluationPackage",
    reads,
    validator: lifecycleValidator,
  });
  if (pkg && !issues.length) {
    if (!isDeepStrictEqual(pkg.candidate, execution.result.candidate)) {
      issues.push("The Evaluation Package evaluated a different candidate than the one supplied.");
    }
    if (pkg.status !== status) issues.push("The Evaluation Package status differs from the StageResult status.");
    if (status === "pass") {
      const contractRef = workContractRef(invocation);
      const contract = parseYaml(
        (await reads.fileAt(String(contractRef.commit_sha), String(contractRef.path))).toString("utf8"),
      ) as { required_validation?: { name: string }[] };
      issues.push(
        ...compareRequiredValidation(
          contract.required_validation ?? [],
          (pkg.checks as Record<string, unknown>[]) ?? [],
          "The Evaluation Package",
        ),
      );
    }
  }
  const current = await getCard(cardId);
  if (!freezeStillActive(current, invocation)) {
    issues.push("The freeze that authorized this evaluation is no longer active; the result is superseded.");
  }
  if (!(await recordDecision(cardId, run, packageRef, issues))) {
    await commentOnCard(cardId, `⏸️ The evaluation result was not routed. The card stays in Evaluation for triage.`);
    return;
  }

  const route = routeEvaluation(pkg!.status, pkg!.findings);
  switch (route) {
    case "human_approval":
      await moveCard(cardId, getWorkflowListId("humanApproval"));
      await commentOnCard(
        cardId,
        "✅ Independent evaluation passed and was verified. Awaiting Human Approval; the Orchestrator never approves or releases.",
      );
      return;
    case "execution_rework": {
      const freezeEventId = (invocation.freeze_activation as Record<string, unknown>).event_id;
      const used = reworkCount(comments, freezeEventId);
      if (used >= config.evaluationReworkLimit) {
        await commentOnCard(
          cardId,
          `↩️ Evaluation failed on implementation findings, but ${used} automatic rework run(s) have already been made under this freeze (limit ${config.evaluationReworkLimit}). The card stays in Evaluation for the accountable human.`,
        );
        return;
      }
      await commentOnCard(
        cardId,
        `↩️ Evaluation failed on implementation findings. Returning to ${getWorkflowStageLabel("execution")} for bounded rework (${used + 1} of ${config.evaluationReworkLimit}).`,
      );
      await moveCard(cardId, getWorkflowListId("execution"));
      return;
    }
    case "hold_specification":
      await commentOnCard(
        cardId,
        `⏸️ Evaluation found a defect in the accepted specification. A specification correction needs the accountable human: if it is non-material, the product owner may move the card to ${getWorkflowStageLabel("specDesign")}; a material change needs a successor intent.`,
      );
      return;
    case "hold_policy":
      await commentOnCard(
        cardId,
        "⏸️ Evaluation found a blocking policy finding. Policy decisions belong to the accountable human; the card stays in Evaluation.",
      );
      return;
    default:
      await commentOnCard(
        cardId,
        "❓ The Evaluator needs a human decision; see the findings above. The card stays in Evaluation.",
      );
  }
}

/** Starts rework after an Evaluation -> Execution move, only when the newest evaluation routed there. */
async function startRework(cardId: string, eventId: string): Promise<void> {
  const card = await getCard(cardId);
  if (card.idList !== getWorkflowListId("execution")) return;
  const comments = await getCardComments(cardId);
  const evaluation = latestStageRun(comments, "evaluation", cardId, lifecycleValidator);
  const execution = latestStageRun(comments, "execution", cardId, lifecycleValidator);
  const refuse = (reason: string) => commentOnCard(cardId, `⛔ Rework was not started: ${reason}`);
  if (!evaluation || evaluation.result.status !== "fail") return refuse("the newest evaluation is not a failed one.");
  if (!execution) return refuse("there is no recorded Execution run to rework.");
  if (!acceptedDecisionFor(comments, evaluation.result.invocation_id)) {
    return refuse("the newest evaluation has no accepted StageResultDecision.");
  }
  const evidenceRef = (execution.result.output_artifacts as Record<string, unknown>[])[0];
  if (
    !(evaluation.invocation.input_artifacts as Record<string, unknown>[]).some((ref) =>
      isDeepStrictEqual(ref, evidenceRef),
    )
  ) {
    return refuse("the newest evaluation did not evaluate the newest candidate.");
  }
  if (!freezeStillActive(card, execution.invocation)) return refuse("the freeze is no longer active.");

  const packageRef = (evaluation.result.output_artifacts as Record<string, unknown>[])[0];
  const target = evaluation.invocation.target as Record<string, unknown>;
  const reads = await productReads(String(target.repository));
  const { pkg, issues } = await verifyPushedPackage({
    ref: packageRef,
    branch: String(evaluation.invocation.workspace_ref),
    handoff: String(target.commit_sha),
    definition: "EvaluationPackage",
    reads,
    validator: lifecycleValidator,
  });
  if (!pkg || issues.length) return refuse(issues.join(" ") || "the Evaluation Package could not be read.");
  if (routeEvaluation(pkg.status, pkg.findings) !== "execution_rework") {
    return refuse("the evaluation's findings do not route to Execution; a human must resolve them.");
  }
  const freezeEventId = (execution.invocation.freeze_activation as Record<string, unknown>).event_id;
  if (reworkCount(comments, freezeEventId) >= config.evaluationReworkLimit) {
    return refuse(`the automatic rework limit (${config.evaluationReworkLimit}) for this freeze is reached.`);
  }
  enqueueCard({ kind: "rework", cardId, invocation: buildReworkInvocation(execution, evaluation, eventId) });
}

async function processSpecCard(cardId: string, approval: MoveApproval): Promise<void> {
  try {
    await runSpecAndDesign(cardId, approval);
  } catch (err) {
    console.error(`[trello-orchestrator] Spec & Design failed for card ${cardId}:`, err);
    await commentOnCard(
      cardId,
      `❌ Spec & Design could not be completed for this card: ${err instanceof Error ? err.message : String(err)}. The card stays in Spec & Design.`,
    ).catch(() => undefined);
  }
}

async function resolveTargetBaseCommit(repositoryUrl: string): Promise<string> {
  const match = repositoryUrl.replace(/\.git$/, "").match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match) throw new Error("ProductConfig target_repository must be a GitHub repository URL.");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "trello-orchestrator",
  };
  const productRepositoryReadToken = await createGitHubAppReadToken({
    appId: config.orchestratorGithubAppId,
    installationId: config.orchestratorGithubAppInstallationId,
    privateKeyFile: config.orchestratorGithubAppPrivateKeyFile,
    repositoryUrl,
  });
  headers.Authorization = `Bearer ${productRepositoryReadToken}`;
  const repositoryApi = `${config.intentBacklogApiBase.replace(/\/$/, "")}/repos/${match[1]}/${match[2]}`;
  const repositoryResponse = await fetch(repositoryApi, { headers });
  if (!repositoryResponse.ok)
    throw new Error(
      `GitHub returned HTTP ${repositoryResponse.status} while resolving the product repository default branch.`,
    );
  const repository = (await repositoryResponse.json()) as { default_branch?: unknown };
  if (typeof repository.default_branch !== "string" || !repository.default_branch) {
    throw new Error("GitHub did not return a default branch for the product repository.");
  }
  const commitResponse = await fetch(`${repositoryApi}/commits/${encodeURIComponent(repository.default_branch)}`, {
    headers,
  });
  if (!commitResponse.ok)
    throw new Error(
      `GitHub returned HTTP ${commitResponse.status} while resolving the product repository base commit.`,
    );
  const commit = (await commitResponse.json()) as { sha?: unknown };
  if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha)) {
    throw new Error("GitHub did not return a valid full commit SHA for the product repository default branch.");
  }
  return commit.sha;
}

async function runSpecAndDesign(cardId: string, approval: MoveApproval): Promise<void> {
  const card = await getCard(cardId);
  console.log(`[trello-orchestrator] Spec & Design for card ${card.idShort} "${card.name}"`);
  const activeFreeze = activeFreezeForCard(card);
  if (!activeFreeze) {
    await commentOnCard(
      cardId,
      "⛔ Spec & Design was not started: this card has no active Prioritized freeze. Return it to Backlog, reconcile the intent, then move it to Prioritized.",
    );
    return;
  }

  if (!approval.eventId || !activeFreeze.tuple.freezeEventId) {
    await commentOnCard(
      cardId,
      "Spec & Design was not started: the triggering transition or active freeze is missing its event ID.",
    );
    return;
  }

  let resolved;
  try {
    resolved = await resolveSpecRequest(card, {
      githubApiBase: config.intentBacklogApiBase,
      intentBacklogReadToken: config.intentBacklogReadToken,
      approvedBy: activeFreeze.tuple.authorizedBy,
      approvedAt: activeFreeze.tuple.frozenAt,
    });
  } catch (err) {
    if (err instanceof SpecRequestError) {
      await commentOnCard(cardId, `⚠️ Spec & Design Agent was not started:\n\n${err.message}`);
      return;
    }
    throw err;
  }

  if (
    frozenArtifactSha256(resolved.frozenIntentBytes) !== activeFreeze.tuple.intentSha256 ||
    resolved.productId !== activeFreeze.tuple.productId ||
    resolved.intentId !== activeFreeze.tuple.intentId ||
    resolved.intentVersion !== activeFreeze.tuple.intentVersion ||
    resolved.intentCommit !== activeFreeze.tuple.intentCommit ||
    resolved.policyProfileId !== activeFreeze.tuple.policyProfileId ||
    resolved.policyProfileVersion !== activeFreeze.tuple.policyProfileVersion ||
    resolved.policyProfileContentSha256 !== activeFreeze.tuple.policyProfileSha256
  ) {
    await commentOnCard(
      cardId,
      "⛔ Spec & Design was not started: the current intent or policy profile does not match the active Prioritized freeze.",
    );
    return;
  }

  for (const warning of resolved.warnings) {
    await commentOnCard(cardId, `⚠️ ${warning}`);
  }

  const invocationId = randomUUID();
  const runId = randomUUID();
  const freezeActivation = {
    schema_version: "1.0" as const,
    event_id: activeFreeze.tuple.freezeEventId,
    event_type: "activated" as const,
    work_item: {
      product_id: activeFreeze.tuple.productId,
      intent_id: activeFreeze.tuple.intentId,
      intent_version: activeFreeze.tuple.intentVersion,
      trello_card_id: activeFreeze.tuple.cardId,
    },
    intent: {
      repository: `https://github.com/${resolved.intentRepository}`,
      commit_sha: activeFreeze.tuple.intentCommit,
      path: resolved.intentPath,
      sha256: activeFreeze.tuple.intentSha256,
    },
    policy_profile_id: activeFreeze.tuple.policyProfileId,
    policy_profile_version: activeFreeze.tuple.policyProfileVersion,
    policy_profile: {
      repository: `https://github.com/${resolved.intentRepository}`,
      commit_sha: activeFreeze.tuple.policyProfileCommit,
      path: resolved.policyProfilePath,
      sha256: activeFreeze.tuple.policyProfileSha256,
    },
    authorized_by: activeFreeze.tuple.authorizedBy,
    recorded_at: activeFreeze.tuple.frozenAt,
  };
  const freezeValidation = lifecycleValidator.validate("FreezeActivationEvent", freezeActivation);
  if (!freezeValidation.valid) {
    await commentOnCard(
      cardId,
      `Spec & Design was not started: active freeze record is invalid: ${freezeValidation.errors.join("; ")}`,
    );
    return;
  }

  const targetBaseCommit = await resolveTargetBaseCommit(resolved.productConfig.target_repository);

  let workspace;
  try {
    workspace = await prepareSpecWorkspace({
      targetRepository: resolved.productConfig.target_repository,
      baseCommit: targetBaseCommit,
      workspaceRoot: config.specWorkspaceRoot,
      intentId: resolved.intentId,
      invocationId,
      frozenIntentBytes: resolved.frozenIntentBytes,
      frozenPolicyProfileBytes: resolved.frozenPolicyProfileBytes,
    });
  } catch (err) {
    await commentOnCard(
      cardId,
      `❌ Could not create the isolated \`work/${resolved.intentId}\` workspace for Spec & Design: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const request: SpecDesignRequest = {
    requestVersion: 2,
    runId,
    invocationId,
    triggerEventId: approval.eventId,
    stage: "spec_design",
    workItem: resolved.intentId,
    productId: resolved.productId,
    intentContentSha256: resolved.intentContentSha256,
    freezeActivation,
    target: {
      repository: workspace.remoteUrl,
      baseCommit: workspace.baseCommit,
      branch: workspace.branch,
      // Containers use their bind mount; the local development runner uses the host path.
      workspace: config.specDesignRuntime === "local" ? workspace.repositoryPath : `${CONTAINER_WORKSPACE}/repository`,
    },
    readPaths: ["."],
    writePaths: [`.agent/work/${resolved.intentId}`],
  };

  const stageInvocation = {
    schema_version: "1.1",
    invocation_id: request.invocationId,
    trigger_event_id: request.triggerEventId,
    stage: "spec_design",
    work_item: freezeActivation.work_item,
    freeze_activation: freezeActivation,
    input_artifacts: [],
    target: { repository: workspace.remoteUrl.replace(/\.git$/, ""), commit_sha: workspace.baseCommit },
    workspace_ref: workspace.branch,
    read_paths: request.readPaths,
    write_paths: request.writePaths,
  };
  const invocationValidation = lifecycleValidator.validate("StageInvocation", stageInvocation);
  if (!invocationValidation.valid) {
    await commentOnCard(
      cardId,
      `? Spec & Design invocation was not started because its StageInvocation record is invalid: ${invocationValidation.errors.join("; ")}`,
    );
    return;
  }
  await commentOnCard(
    cardId,
    `<!-- agentic-sdlc-stage-invocation ${JSON.stringify(stageInvocation)} -->\nValidated Spec & Design StageInvocation recorded.`,
  );

  const recordStageResult = async (
    status: "spec_ready" | "needs_decision" | "blocked" | "failed",
    outputArtifacts: unknown[],
    summary: string,
    findings?: string[],
  ) => {
    const stageResult = {
      schema_version: "1.0",
      invocation_id: request.invocationId,
      stage: "spec_design",
      work_item: stageInvocation.work_item,
      status,
      output_artifacts: outputArtifacts,
      summary,
      ...(findings?.length ? { findings } : {}),
    };
    const resultValidation = lifecycleValidator.validate("StageResult", stageResult);
    if (!resultValidation.valid) {
      await commentOnCard(
        cardId,
        `? Spec & Design StageResult was rejected because it is invalid: ${resultValidation.errors.join("; ")}`,
      );
      return false;
    }
    await commentOnCard(
      cardId,
      `<!-- agentic-sdlc-stage-result ${JSON.stringify(stageResult)} -->\nValidated Spec & Design StageResult recorded.`,
    );
    return true;
  };

  await commentOnCard(
    cardId,
    `🧭 Spec & Design Agent started for \`${request.workItem}\` (run \`${request.runId}\`) on branch \`${workspace.branch}\`.`,
  );

  const run = await runSpecDesignAgent(request, { hostWorkspace: workspace.path });
  const route = routeSpecResult(run);
  const rawStatus = String(run.result?.status ?? "failed");
  const safeStatus = (
    ["spec_ready", "needs_decision", "blocked", "failed"].includes(rawStatus) ? rawStatus : "failed"
  ) as "spec_ready" | "needs_decision" | "blocked" | "failed";
  if (run.result?.status === "spec_ready") {
    const contractPath = typeof run.result.workContractPath === "string" ? run.result.workContractPath : "";
    const specCommit = typeof run.result.specCommit === "string" ? run.result.specCommit : "";
    if (!contractPath || !specCommit) {
      await recordStageResult("blocked", [], "Spec & Design omitted the committed Work Contract v3 reference.", [
        "Missing workContractPath or specCommit",
      ]);
      await commentOnCard(
        cardId,
        "? Spec & Design output is not eligible for Design Review: it must include a committed Work Contract v3 path and commit reference. The current Spec & Design Agent result does not provide that contract yet.",
      );
      return;
    }
    try {
      const contractText = await readCommittedWorkspaceFile(workspace.repositoryPath, specCommit, contractPath);
      const contract = parseYaml(contractText);
      const issues = validateWorkContractV3(
        contract,
        {
          productId: resolved.productId,
          intentId: resolved.intentId,
          intentVersion: resolved.intentVersion,
          cardId: card.id,
          intentRepository: `https://github.com/${resolved.intentRepository}`,
          intentCommit: resolved.intentCommit,
          intentPath: resolved.intentPath,
          intentSha256: frozenArtifactSha256(resolved.frozenIntentBytes),
          policyProfileId: resolved.policyProfileId,
          policyProfileVersion: resolved.policyProfileVersion,
          policyProfilePath: resolved.policyProfilePath,
          policyProfileSha256: resolved.policyProfileContentSha256,
          targetRepository: workspace.remoteUrl.replace(/\.git$/, ""),
          targetCommit: workspace.baseCommit,
        },
        lifecycleValidator,
      );
      if (issues.length > 0) {
        await recordStageResult(
          "blocked",
          [],
          "The proposed Work Contract v3 failed canonical schema or frozen-reference checks.",
          issues,
        );
        await commentOnCard(
          cardId,
          "? Spec & Design output is not eligible for Design Review:\n\n" +
            issues.map((issue) => `- ${issue}`).join("\n"),
        );
        return;
      }
      const specPath = typeof run.result.specPath === "string" ? run.result.specPath : "";
      if (!specPath) {
        await recordStageResult("blocked", [], "Spec & Design omitted the committed spec.md path.", [
          "Missing specPath",
        ]);
        await commentOnCard(
          cardId,
          "? Spec & Design output is not eligible for Design Review: the committed spec.md path is missing.",
        );
        return;
      }
      const specText = await readCommittedWorkspaceFile(workspace.repositoryPath, specCommit, specPath);
      const repository = workspace.remoteUrl.replace(/\.git$/, "");
      const outputArtifacts = [
        {
          repository,
          commit_sha: specCommit,
          path: specPath,
          sha256: createHash("sha256").update(specText, "utf8").digest("hex"),
        },
        {
          repository,
          commit_sha: specCommit,
          path: contractPath,
          sha256: createHash("sha256").update(contractText, "utf8").digest("hex"),
        },
      ];
      if (
        !(await recordStageResult(
          "spec_ready",
          outputArtifacts,
          String(run.result.summary ?? "Spec and Work Contract v3 are ready for human review."),
        ))
      )
        return;
    } catch (err) {
      await recordStageResult(
        "blocked",
        [],
        "The committed Work Contract v3 could not be read, parsed, or validated.",
        [err instanceof Error ? err.message : String(err)],
      );
      await commentOnCard(
        cardId,
        `? The committed Work Contract v3 could not be read or parsed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  } else {
    const summary = String(
      run.result?.summary ?? "The Spec & Design Agent did not return a parseable successful result.",
    );
    const findings = Array.isArray(run.result?.blockingConcerns) ? run.result.blockingConcerns.map(String) : [];
    if (!(await recordStageResult(safeStatus, [], summary, findings))) return;
  }
  await commentOnCard(cardId, route.comment);

  if (route.comment.includes("spec ready for human review")) {
    const productRepositoryReadToken = await createGitHubAppReadToken({
      appId: config.orchestratorGithubAppId,
      installationId: config.orchestratorGithubAppInstallationId,
      privateKeyFile: config.orchestratorGithubAppPrivateKeyFile,
      repositoryUrl: workspace.remoteUrl,
    });
    const published = await verifySpecBranchPublished(
      { ...workspace, path: workspace.repositoryPath },
      productRepositoryReadToken,
    );
    await commentOnCard(
      cardId,
      published.pushed
        ? `📤 Work branch published for Design Review: ${published.branchUrl}`
        : `⚠️ The spec is committed locally on \`${workspace.branch}\` but could not be pushed for review: ${published.reason}`,
    );
  }
}

export async function handleCardPrioritized(cardId: string, approval: MoveApproval): Promise<void> {
  const card = await getCard(cardId);
  const prior = readFreezeProjection(card.desc ?? "");
  if (prior?.state === "Active") {
    await commentOnCard(
      cardId,
      "ℹ️ This card already has an active Prioritized freeze; duplicate board events did not create another freeze.",
    );
    return;
  }
  try {
    const resolved = await resolveSpecRequest(card, {
      githubApiBase: config.intentBacklogApiBase,
      intentBacklogReadToken: config.intentBacklogReadToken,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
    });
    const tuple: FreezeTuple = {
      productId: resolved.productId,
      intentId: resolved.intentId,
      intentVersion: resolved.intentVersion,
      intentCommit: resolved.intentCommit,
      intentSha256: frozenArtifactSha256(resolved.frozenIntentBytes),
      policyProfileId: resolved.policyProfileId,
      policyProfileVersion: resolved.policyProfileVersion,
      policyProfileCommit: resolved.intentCommit,
      policyProfileSha256: resolved.policyProfileContentSha256,
      cardId,
      freezeEventId: approval.eventId,
      authorizedBy: approval.approvedBy,
      frozenAt: approval.approvedAt,
    };
    const freezeRecord = {
      schema_version: "1.0",
      event_id: approval.eventId ?? randomUUID(),
      event_type: "activated",
      work_item: {
        product_id: resolved.productId,
        intent_id: resolved.intentId,
        intent_version: resolved.intentVersion,
        trello_card_id: cardId,
      },
      intent: {
        repository: `https://github.com/${resolved.intentRepository}`,
        commit_sha: resolved.intentCommit,
        path: resolved.intentPath,
        sha256: frozenArtifactSha256(resolved.frozenIntentBytes),
      },
      policy_profile_id: resolved.policyProfileId,
      policy_profile_version: resolved.policyProfileVersion,
      policy_profile: {
        repository: `https://github.com/${resolved.intentRepository}`,
        commit_sha: resolved.intentCommit,
        path: resolved.policyProfilePath,
        sha256: resolved.policyProfileContentSha256,
      },
      authorized_by: approval.approvedBy,
      recorded_at: approval.approvedAt,
    };
    const recordValidation = lifecycleValidator.validate("FreezeActivationEvent", freezeRecord);
    if (!recordValidation.valid)
      throw new Error(`FreezeActivationEvent is invalid: ${recordValidation.errors.join("; ")}`);
    const projection = { state: "Active" as const, tuple };
    await updateCardDescription(cardId, writeFreezeProjection(card.desc ?? "", projection));
    await commentOnCard(
      cardId,
      `<!-- agentic-sdlc-freeze-event ${JSON.stringify(freezeRecord)} -->\nValidated Prioritized freeze activation record.`,
    );
    await commentOnCard(cardId, `🔒 Prioritized freeze activated.\n\n${JSON.stringify(projection, null, 2)}`);
  } catch (err) {
    const backlogId = getWorkflowListId("backlog");
    await moveCard(cardId, backlogId);
    await commentOnCard(
      cardId,
      `⛔ Prioritized freeze was not activated; the card was returned to Backlog.\n\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function handleCardFreezeRevocation(
  cardId: string,
  revokedBy: string,
  revokedAt: string,
  eventId?: string,
): Promise<void> {
  const card = await getCard(cardId);
  const projection = readFreezeProjection(card.desc ?? "");
  if (!projection || projection.state !== "Active") return;
  if (!projection.tuple.freezeEventId) {
    await commentOnCard(
      cardId,
      "Freeze revocation was not recorded because the active freeze projection has no activation event ID.",
    );
    return;
  }
  const freezeRecord = {
    schema_version: "1.0",
    event_id: eventId ?? randomUUID(),
    event_type: "revoked",
    work_item: {
      product_id: projection.tuple.productId,
      intent_id: projection.tuple.intentId,
      intent_version: projection.tuple.intentVersion,
      trello_card_id: cardId,
    },
    revokes_event_id: projection.tuple.freezeEventId,
    authorized_by: revokedBy,
    recorded_at: revokedAt,
    reason: "The product owner returned the card to an editable pre-execution stage.",
  };
  const recordValidation = lifecycleValidator.validate("FreezeRevocationEvent", freezeRecord);
  if (!recordValidation.valid) {
    await commentOnCard(
      cardId,
      `Freeze revocation was not recorded because the event is invalid: ${recordValidation.errors.join("; ")}`,
    );
    return;
  }
  const revoked = { ...projection, state: "Revoked" as const, revokedBy, revokedAt };
  await updateCardDescription(cardId, writeFreezeProjection(card.desc ?? "", revoked));
  await commentOnCard(
    cardId,
    `<!-- agentic-sdlc-freeze-event ${JSON.stringify(freezeRecord)} -->\nValidated Prioritized freeze revocation record.`,
  );
  await commentOnCard(
    cardId,
    `🔓 Prioritized freeze revoked because the card returned to ${card.idList === getWorkflowListId("newIdeas") ? getWorkflowStageLabel("newIdeas") : getWorkflowStageLabel("backlog")}.\n\n${JSON.stringify(revoked, null, 2)}`,
  );
}

export function handleCardReadyForAgent(
  cardId: string,
  acceptance: Record<string, unknown>,
  workspaceRef: string,
  targetCommit: string,
  freezeActivation: Record<string, unknown>,
): void {
  enqueueCard({ kind: "accepted", cardId, acceptance, workspaceRef, targetCommit, freezeActivation });
}

export function handleCardReviewForAgent(cardId: string, eventId: string): void {
  enqueueReview(cardId, eventId);
}

/** An Evaluation -> Execution move: rework, if the newest verified evaluation routed there. */
export async function handleCardRework(cardId: string, eventId: string): Promise<void> {
  await startRework(cardId, eventId);
}

export function handleCardSpecAndDesign(cardId: string, approval: MoveApproval): void {
  if (config.specDesignKickoffMode === "manual") {
    void commentOnCard(
      cardId,
      `${manualSpecMarker}${JSON.stringify(approval)} -->\nSpec & Design is ready for a local manual run. From the Orchestrator repo, run: \`npm run spec-design:manual -- --card-id ${cardId}\` with \`SPEC_DESIGN_KICKOFF_MODE=manual\`, \`SPEC_DESIGN_RUNTIME=local\`, \`SPEC_DESIGN_AGENT_PROVIDER=codex\`, and \`SPEC_DESIGN_AGENT_DIR\` set to the local Spec & Design Agent checkout.`,
    ).catch((err) =>
      console.error(`[trello-orchestrator] Could not record the manual Spec & Design kickoff for ${cardId}:`, err),
    );
    return;
  }
  enqueueSpec(cardId, approval);
}

/** Starts a previously recorded Spec & Design transition from the local CLI. */
export async function runManualSpecDesign(cardId: string): Promise<void> {
  const card = await getCard(cardId);
  if (card.idList !== getWorkflowListId("specDesign")) {
    throw new Error("The card must remain in Spec & Design before a manual run can start.");
  }
  const { getCardComments } = await import("../trello/client.js");
  const comments = await getCardComments(cardId);
  const marker = comments.find((comment) => comment.data.text?.startsWith(manualSpecMarker));
  if (!marker?.data.text) {
    throw new Error(
      "No recorded Spec & Design transition was found. Move the card into Spec & Design through the Orchestrator first.",
    );
  }
  let approval: MoveApproval;
  try {
    approval = JSON.parse(marker.data.text.slice(manualSpecMarker.length).split(" -->", 1)[0]) as MoveApproval;
  } catch {
    throw new Error("The recorded manual Spec & Design transition is malformed.");
  }
  if (!approval.eventId || !approval.approvedAt || !approval.approvedBy) {
    throw new Error("The recorded manual Spec & Design transition is incomplete.");
  }
  await processSpecCard(cardId, approval);
}
