// ABOUTME: Coordinates spec & design, coding, and remote evaluation transitions for Trello work items.
import { runCodingAgent } from "../codingAgent/runCodingAgent.js";
import { CONTAINER_WORKSPACE, runSpecDesignAgent, type SpecDesignRequest } from "../specDesignAgent/runSpecDesignAgent.js";
import { resolveSpecRequest, SpecRequestError } from "./specRequestFromCard.js";
import { routeSpecResult } from "./specRouting.js";
import { prepareSpecWorkspace, readCommittedWorkspaceFile, verifySpecBranchPublished } from "./specWorkspace.js";
import { prepareGitEvaluationHandoff } from "../evaluatorAgent/gitHandoff.js";
import { runRemoteEvaluator } from "../evaluatorAgent/remote.js";
import { readArtifactRef } from "./humanRecords.js";
import { commentOnCard, getCard, getWorkflowListId, getWorkflowStageLabel, moveCard, updateCardDescription } from "../trello/client.js";
import { config } from "../config.js";
import { isUnderWipLimit } from "./wip.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { activeFreezeForCard, readFreezeProjection, writeFreezeProjection, type FreezeTuple } from "./freezeState.js";
import { frozenArtifactSha256 } from "./specRequestFromCard.js";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { parse as parseYaml } from "yaml";
import { validateWorkContractV3 } from "./workContractV3.js";
import { loadAcceptedExecutionContract } from "./acceptedExecutionContract.js";
import { createGitHubAppReadToken } from "../githubApp.js";

const lifecycleValidator = createLifecycleValidator(config.lifecycleSchemaPath);

export interface MoveApproval {
  approvedBy: string;
  approvedAt: string;
  eventId?: string;
}

interface AcceptedExecution {
  cardId: string;
  acceptance: Record<string, unknown>;
  workspaceRef: string;
  targetCommit: string;
  freezeActivation: Record<string, unknown>;
}
const pendingQueue: AcceptedExecution[] = [];
const pendingReviewQueue: string[] = [];
const pendingSpecQueue: Array<{ cardId: string; approval: MoveApproval }> = [];
const manualSpecMarker = "<!-- agentic-sdlc-manual-spec-kickoff ";
let processing = false;
let reviewing = false;
let specing = false;
const handoffMarker = "<!-- agentic-sdlc-evaluator-handoff ";

export function enqueueCard(execution: AcceptedExecution): void {
  if (!pendingQueue.some((entry) => entry.cardId === execution.cardId)) pendingQueue.push(execution);
  void drainQueue();
}

function enqueueReview(cardId: string): void {
  if (!pendingReviewQueue.includes(cardId)) pendingReviewQueue.push(cardId);
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
    while (pendingReviewQueue.length > 0) await evaluateCard(pendingReviewQueue.shift()!);
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
      await processCard(pendingQueue.shift()!);
    }
  } finally {
    processing = false;
  }
}

async function processCard(execution: AcceptedExecution): Promise<void> {
  const { cardId } = execution;
  const card = await getCard(cardId);
  console.log(`[trello-orchestrator] Processing card ${card.idShort} "${card.name}"`);

  let invocation: Record<string, unknown>;
  try {
    const executionListId = getWorkflowListId("execution");
    if (card.idList !== executionListId) throw new Error("The card no longer resides in Execution.");
    const loaded = await loadAcceptedExecutionContract({
      card,
      acceptance: execution.acceptance,
      workspaceRef: execution.workspaceRef,
      targetCommit: execution.targetCommit,
      workspaceRoot: config.specWorkspaceRoot,
      intentBacklogApiBase: config.intentBacklogApiBase,
      intentBacklogReadToken: config.intentBacklogReadToken,
      createProductRepositoryReadToken: (repositoryUrl) => createGitHubAppReadToken({
        appId: config.orchestratorGithubAppId,
        installationId: config.orchestratorGithubAppInstallationId,
        privateKeyFile: config.orchestratorGithubAppPrivateKeyFile,
        repositoryUrl,
      }),
      freezeActivation: execution.freezeActivation,
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

  const workingListId = getWorkflowListId("execution");
  const reviewListId = getWorkflowListId("evaluation");
  if (card.idList !== workingListId) return;
  const invocationWorkItem = invocation.work_item as Record<string, unknown>;
  const workItemId = String(invocationWorkItem.intent_id ?? "");
  await commentOnCard(cardId, `🤖 Coding Agent started (work item \`${workItemId}\`).`);

  const coding = await runCodingAgent(invocation, {
    endpoint: config.codingAgentApiUrl,
    token: config.codingAgentApiToken,
    pollIntervalMs: config.codingAgentPollIntervalMs,
    timeoutMs: config.codingAgentTimeoutMs,
  });
  if (!coding.stageResult) {
    await commentOnCard(cardId, `❌ Coding Agent produced no parseable StageResult: ${coding.error ?? "the finished run had no stage_result"}. Needs human investigation.\n\n${coding.rawOutput.slice(-1500)}`);
    return;
  }

  const stageValidation = lifecycleValidator.validate("StageResult", coding.stageResult);
  if (!stageValidation.valid || coding.stageResult.invocation_id !== invocation.invocation_id || coding.stageResult.stage !== "execution") {
    await commentOnCard(cardId, `❌ Coding Agent StageResult was rejected: ${stageValidation.errors.join("; ") || "its invocation identity did not match."}`);
    return;
  }
  const codingStatus = String(coding.stageResult.status ?? "unknown");
  const codingSummary = String(coding.stageResult.summary ?? "(no summary)");
  await commentOnCard(cardId, `🤖 Coding Agent finished: **${codingStatus}**\n\n${codingSummary}`);

  if (codingStatus !== "candidate_complete") {
    await commentOnCard(cardId, "⏸️ Evaluator was not invoked because only `candidate_complete` implementations are eligible for independent evaluation.");
    return;
  }

  if (!coding.evidencePackage) {
    await commentOnCard(cardId, "❌ Coding Agent did not provide the canonical Evidence Package required for Evaluation.");
    return;
  }
  const evidenceValidation = lifecycleValidator.validate("EvidencePackage", coding.evidencePackage);
  if (!evidenceValidation.valid) {
    await commentOnCard(cardId, `❌ Coding Agent Evidence Package was rejected: ${evidenceValidation.errors.join("; ")}`);
    return;
  }
  const handoff = await prepareGitEvaluationHandoff({
    invocation,
    stageResult: coding.stageResult,
    evidencePackage: coding.evidencePackage,
  });
  const handoffComment = JSON.stringify(handoff);
  await commentOnCard(cardId, `${handoffMarker}${handoffComment} -->\n🔎 Independent evaluation is ready from candidate revision \`${handoff.candidateRevision}\`. Moving this card to ${getWorkflowStageLabel("evaluation")} starts the Evaluator Agent.`);
  await moveCard(cardId, reviewListId);
}

async function evaluateCard(cardId: string): Promise<void> {
  const card = await getCard(cardId);
  const { getCardComments } = await import("../trello/client.js");
  const comments = await getCardComments(cardId);
  const handoffComment = comments.find((comment) => comment.data.text?.startsWith(handoffMarker));
  if (!handoffComment?.data.text) {
    await commentOnCard(cardId, `⚠️ ${getWorkflowStageLabel("evaluation")} was entered without an evaluator handoff. No evaluator run was started.`);
    return;
  }
  let handoff: Record<string, unknown>;
  try {
    const payload = handoffComment.data.text.slice(handoffMarker.length).split(" -->", 1)[0];
    handoff = JSON.parse(payload);
  } catch {
    await commentOnCard(cardId, "⚠️ The evaluator handoff metadata is invalid. No evaluator run was started.");
    return;
  }
  const workItem = handoff.workItem as Record<string, unknown> | undefined;
  const intentRef = handoff.intentRef as Record<string, unknown> | undefined;
  const contractRef = handoff.contractRef as Record<string, unknown> | undefined;
  const evidenceRef = handoff.evidenceRef as Record<string, unknown> | undefined;
  if (!handoff.repositoryUrl || !handoff.branch || !handoff.candidateRevision || !handoff.branchRevision || !workItem || !intentRef || !contractRef || !evidenceRef || !handoff.packagePath) {
    await commentOnCard(cardId, "⚠️ The evaluator handoff is incomplete. No evaluator run was started.");
    return;
  }
  await commentOnCard(cardId, `🔎 Independent Evaluator Agent started because the card entered ${getWorkflowStageLabel("evaluation")}.`);

  let productRepositoryReadToken: string;
  try {
    productRepositoryReadToken = await createGitHubAppReadToken({
      appId: config.orchestratorGithubAppId,
      installationId: config.orchestratorGithubAppInstallationId,
      privateKeyFile: config.orchestratorGithubAppPrivateKeyFile,
      repositoryUrl: String(handoff.repositoryUrl),
    });
  } catch (err) {
    await commentOnCard(cardId, `❌ Orchestrator could not mint a product-repository read token: ${err instanceof Error ? err.message : String(err)}. Card remains in ${getWorkflowStageLabel("evaluation")}.`);
    return;
  }

  let evaluated;
  try {
    evaluated = await runRemoteEvaluator({
      endpoint: `${config.evaluatorApiUrl.replace(/\/$/, "")}/evaluations`,
      token: config.evaluatorApiToken,
      repositoryUrl: String(handoff.repositoryUrl),
      branch: String(handoff.branch),
      revision: String(handoff.candidateRevision),
      branchRevision: String(handoff.branchRevision),
      workItem,
      intentRef,
      contractRef,
      evidenceRef,
      intentText: await readArtifactRef(intentRef, config.intentBacklogApiBase, productRepositoryReadToken),
      contractText: await readArtifactRef(contractRef, config.intentBacklogApiBase, productRepositoryReadToken),
      evidenceText: await readArtifactRef(evidenceRef, config.intentBacklogApiBase, productRepositoryReadToken),
      packagePath: String(handoff.packagePath),
    });
  } catch (err) {
    await commentOnCard(cardId, `❌ Evaluator could not start: ${err instanceof Error ? err.message : String(err)}. Card remains in ${getWorkflowStageLabel("evaluation")}.`);
    return;
  }

  if (!evaluated.evaluation || !evaluated.evaluationPackage) {
    await commentOnCard(cardId, `❌ Evaluator produced no parseable result (exit code ${evaluated.exitCode}). Card remains in ${getWorkflowStageLabel("evaluation")} for investigation.\n\n\`\`\`\n${evaluated.rawOutput.slice(-1500)}\n\`\`\``);
    return;
  }
  const evaluationPackage = evaluated.evaluationPackage;
  if (evaluationPackage.repositoryUrl.replace(/\.git$/i, "") !== String(handoff.repositoryUrl).replace(/\.git$/i, "") ||
      evaluationPackage.branch !== String(handoff.branch) || evaluationPackage.candidateRevision !== String(handoff.candidateRevision) ||
      evaluationPackage.path !== String(handoff.packagePath) || !/^[0-9a-f]{40}$/i.test(evaluationPackage.packageRevision) || !/^[0-9a-f]{64}$/i.test(evaluationPackage.sha256)) {
    await commentOnCard(cardId, "Evaluator returned an Evaluation Package reference that does not match this candidate handoff. The card remains in Evaluation for investigation.");
    return;
  }

  const status = String(evaluated.evaluation.status ?? "unknown");
  const summary = String(evaluated.evaluation.summary ?? "(no summary)");
  const findings = Array.isArray(evaluated.evaluation.findings) ? evaluated.evaluation.findings as Array<Record<string, unknown>> : [];
  let comment = `🔎 Evaluator finished: **${status.toUpperCase()}**\n\n${summary}`;
  if (findings.length > 0) {
    comment += "\n\n**Findings**";
    for (const finding of findings.slice(0, 10)) {
      comment += `\n- ${finding.id ?? "finding"} [${finding.severity ?? "unknown"}]: ${finding.problem ?? "(no description)"}`;
    }
  }
  const decisionBrief = evaluated.evaluation.decisionBrief as Record<string, unknown> | undefined;
  if (status === "needs_decision" && decisionBrief) {
    const facts = Array.isArray(decisionBrief.knownFacts) ? decisionBrief.knownFacts : [];
    const inferences = Array.isArray(decisionBrief.evaluatorInferences) ? decisionBrief.evaluatorInferences : [];
    const options = Array.isArray(decisionBrief.options) ? decisionBrief.options as Array<Record<string, unknown>> : [];
    comment += `\n\n## Human Decision Required\n\n**Decision:** ${decisionBrief.decisionRequired ?? "Not provided"}\n\n**Why now:** ${decisionBrief.whyNow ?? "Not provided"}`;
    if (facts.length) comment += `\n\n**Known facts**\n${facts.map((fact) => `- ${String(fact)}`).join("\n")}`;
    if (inferences.length) comment += `\n\n**Evaluator inferences**\n${inferences.map((inference) => `- ${String(inference)}`).join("\n")}`;
    if (options.length) comment += `\n\n**Options**\n${options.map((option) => `- ${String(option.option ?? "Option")}: ${String(option.impact ?? "Impact not provided")}`).join("\n")}`;
    comment += `\n\n**If no decision is made:** ${decisionBrief.consequenceOfNoDecision ?? "Work remains blocked."}`;
  }
  await commentOnCard(cardId, comment);
  await commentOnCard(cardId, `Evaluation Package published at \`${evaluationPackage.path}\` on \`${evaluationPackage.branch}\` (package commit \`${evaluationPackage.packageRevision}\`, candidate \`${evaluationPackage.candidateRevision}\`, SHA-256 \`${evaluationPackage.sha256}\`).`);

  if (status === "pass") {
    const humanApprovalListId = getWorkflowListId("humanApproval");
    await moveCard(cardId, humanApprovalListId);
    await commentOnCard(cardId, "✅ Independent evaluation passed. Awaiting Human Approval. Trello Orchestrator never moves work to Done.");
  } else if (status === "fail") {
    await commentOnCard(cardId, `↩️ Independent evaluation failed. Findings require implementation rework. Card remains in ${getWorkflowStageLabel("evaluation")}; automatic retry is intentionally not enabled in v0.1.`);
  } else if (status === "needs_decision") {
    // Keep the request in Evaluation; the card move itself remains human-authorized.
    await commentOnCard(cardId, "❓ Evaluator requires human judgment. The decision brief above contains the evidence, options, and consequence of waiting.");
  } else {
    await commentOnCard(cardId, `⚠️ Unknown evaluator status \`${status}\`. Card remains in ${getWorkflowStageLabel("evaluation")}.`);
  }
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
  if (!repositoryResponse.ok) throw new Error(`GitHub returned HTTP ${repositoryResponse.status} while resolving the product repository default branch.`);
  const repository = (await repositoryResponse.json()) as { default_branch?: unknown };
  if (typeof repository.default_branch !== "string" || !repository.default_branch) {
    throw new Error("GitHub did not return a default branch for the product repository.");
  }
  const commitResponse = await fetch(`${repositoryApi}/commits/${encodeURIComponent(repository.default_branch)}`, { headers });
  if (!commitResponse.ok) throw new Error(`GitHub returned HTTP ${commitResponse.status} while resolving the product repository base commit.`);
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
    await commentOnCard(cardId, "⛔ Spec & Design was not started: this card has no active Prioritized freeze. Return it to Backlog, reconcile the intent, then move it to Prioritized.");
    return;
  }

  if (!approval.eventId || !activeFreeze.tuple.freezeEventId) {
    await commentOnCard(cardId, "Spec & Design was not started: the triggering transition or active freeze is missing its event ID.");
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
    await commentOnCard(cardId, "⛔ Spec & Design was not started: the current intent or policy profile does not match the active Prioritized freeze.");
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
    await commentOnCard(cardId, `Spec & Design was not started: active freeze record is invalid: ${freezeValidation.errors.join("; ")}`);
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
    await commentOnCard(cardId, `? Spec & Design invocation was not started because its StageInvocation record is invalid: ${invocationValidation.errors.join("; ")}`);
    return;
  }
  await commentOnCard(cardId, `<!-- agentic-sdlc-stage-invocation ${JSON.stringify(stageInvocation)} -->\nValidated Spec & Design StageInvocation recorded.`);

  const recordStageResult = async (status: "spec_ready" | "needs_decision" | "blocked" | "failed", outputArtifacts: unknown[], summary: string, findings?: string[]) => {
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
      await commentOnCard(cardId, `? Spec & Design StageResult was rejected because it is invalid: ${resultValidation.errors.join("; ")}`);
      return false;
    }
    await commentOnCard(cardId, `<!-- agentic-sdlc-stage-result ${JSON.stringify(stageResult)} -->\nValidated Spec & Design StageResult recorded.`);
    return true;
  };

  await commentOnCard(
    cardId,
    `🧭 Spec & Design Agent started for \`${request.workItem}\` (run \`${request.runId}\`) on branch \`${workspace.branch}\`.`,
  );

  const run = await runSpecDesignAgent(request, { hostWorkspace: workspace.path });
  const route = routeSpecResult(run);
  const rawStatus = String(run.result?.status ?? "failed");
  const safeStatus = (["spec_ready", "needs_decision", "blocked", "failed"].includes(rawStatus) ? rawStatus : "failed") as "spec_ready" | "needs_decision" | "blocked" | "failed";
  if (run.result?.status === "spec_ready") {
    const contractPath = typeof run.result.workContractPath === "string" ? run.result.workContractPath : "";
    const specCommit = typeof run.result.specCommit === "string" ? run.result.specCommit : "";
    if (!contractPath || !specCommit) {
      await recordStageResult("blocked", [], "Spec & Design omitted the committed Work Contract v3 reference.", ["Missing workContractPath or specCommit"]);
      await commentOnCard(cardId, "? Spec & Design output is not eligible for Design Review: it must include a committed Work Contract v3 path and commit reference. The current Spec & Design Agent result does not provide that contract yet.");
      return;
    }
    try {
      const contractText = await readCommittedWorkspaceFile(workspace.repositoryPath, specCommit, contractPath);
      const contract = parseYaml(contractText);
      const issues = validateWorkContractV3(contract, {
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
      }, lifecycleValidator);
      if (issues.length > 0) {
        await recordStageResult("blocked", [], "The proposed Work Contract v3 failed canonical schema or frozen-reference checks.", issues);
        await commentOnCard(cardId, "? Spec & Design output is not eligible for Design Review:\n\n" + issues.map((issue) => `- ${issue}`).join("\n"));
        return;
      }
      const specPath = typeof run.result.specPath === "string" ? run.result.specPath : "";
      if (!specPath) {
        await recordStageResult("blocked", [], "Spec & Design omitted the committed spec.md path.", ["Missing specPath"]);
        await commentOnCard(cardId, "? Spec & Design output is not eligible for Design Review: the committed spec.md path is missing.");
        return;
      }
      const specText = await readCommittedWorkspaceFile(workspace.repositoryPath, specCommit, specPath);
      const repository = workspace.remoteUrl.replace(/\.git$/, "");
      const outputArtifacts = [
        { repository, commit_sha: specCommit, path: specPath, sha256: createHash("sha256").update(specText, "utf8").digest("hex") },
        { repository, commit_sha: specCommit, path: contractPath, sha256: createHash("sha256").update(contractText, "utf8").digest("hex") },
      ];
      if (!(await recordStageResult("spec_ready", outputArtifacts, String(run.result.summary ?? "Spec and Work Contract v3 are ready for human review.")))) return;
    } catch (err) {
      await recordStageResult("blocked", [], "The committed Work Contract v3 could not be read, parsed, or validated.", [err instanceof Error ? err.message : String(err)]);
      await commentOnCard(cardId, `? The committed Work Contract v3 could not be read or parsed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  } else {
    const summary = String(run.result?.summary ?? "The Spec & Design Agent did not return a parseable successful result.");
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
    const published = await verifySpecBranchPublished({ ...workspace, path: workspace.repositoryPath }, productRepositoryReadToken);
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
    await commentOnCard(cardId, "ℹ️ This card already has an active Prioritized freeze; duplicate board events did not create another freeze.");
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
      work_item: { product_id: resolved.productId, intent_id: resolved.intentId, intent_version: resolved.intentVersion, trello_card_id: cardId },
      intent: { repository: `https://github.com/${resolved.intentRepository}`, commit_sha: resolved.intentCommit, path: resolved.intentPath, sha256: frozenArtifactSha256(resolved.frozenIntentBytes) },
      policy_profile_id: resolved.policyProfileId,
      policy_profile_version: resolved.policyProfileVersion,
      policy_profile: { repository: `https://github.com/${resolved.intentRepository}`, commit_sha: resolved.intentCommit, path: resolved.policyProfilePath, sha256: resolved.policyProfileContentSha256 },
      authorized_by: approval.approvedBy,
      recorded_at: approval.approvedAt,
    };
    const recordValidation = lifecycleValidator.validate("FreezeActivationEvent", freezeRecord);
    if (!recordValidation.valid) throw new Error(`FreezeActivationEvent is invalid: ${recordValidation.errors.join("; ")}`);
    const projection = { state: "Active" as const, tuple };
    await updateCardDescription(cardId, writeFreezeProjection(card.desc ?? "", projection));
    await commentOnCard(cardId, `<!-- agentic-sdlc-freeze-event ${JSON.stringify(freezeRecord)} -->\nValidated Prioritized freeze activation record.`);
    await commentOnCard(cardId, `🔒 Prioritized freeze activated.\n\n${JSON.stringify(projection, null, 2)}`);
  } catch (err) {
    const backlogId = getWorkflowListId("backlog");
    await moveCard(cardId, backlogId);
    await commentOnCard(cardId, `⛔ Prioritized freeze was not activated; the card was returned to Backlog.\n\n${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleCardFreezeRevocation(cardId: string, revokedBy: string, revokedAt: string, eventId?: string): Promise<void> {
  const card = await getCard(cardId);
  const projection = readFreezeProjection(card.desc ?? "");
  if (!projection || projection.state !== "Active") return;
  if (!projection.tuple.freezeEventId) {
    await commentOnCard(cardId, "Freeze revocation was not recorded because the active freeze projection has no activation event ID.");
    return;
  }
  const freezeRecord = {
    schema_version: "1.0",
    event_id: eventId ?? randomUUID(),
    event_type: "revoked",
    work_item: { product_id: projection.tuple.productId, intent_id: projection.tuple.intentId, intent_version: projection.tuple.intentVersion, trello_card_id: cardId },
    revokes_event_id: projection.tuple.freezeEventId,
    authorized_by: revokedBy,
    recorded_at: revokedAt,
    reason: "The product owner returned the card to an editable pre-execution stage.",
  };
  const recordValidation = lifecycleValidator.validate("FreezeRevocationEvent", freezeRecord);
  if (!recordValidation.valid) {
    await commentOnCard(cardId, `Freeze revocation was not recorded because the event is invalid: ${recordValidation.errors.join("; ")}`);
    return;
  }
  const revoked = { ...projection, state: "Revoked" as const, revokedBy, revokedAt };
  await updateCardDescription(cardId, writeFreezeProjection(card.desc ?? "", revoked));
  await commentOnCard(cardId, `<!-- agentic-sdlc-freeze-event ${JSON.stringify(freezeRecord)} -->\nValidated Prioritized freeze revocation record.`);
  await commentOnCard(cardId, `🔓 Prioritized freeze revoked because the card returned to ${card.idList === getWorkflowListId("newIdeas") ? getWorkflowStageLabel("newIdeas") : getWorkflowStageLabel("backlog")}.\n\n${JSON.stringify(revoked, null, 2)}`);
}

export function handleCardReadyForAgent(cardId: string, acceptance: Record<string, unknown>, workspaceRef: string, targetCommit: string, freezeActivation: Record<string, unknown>): void {
  enqueueCard({ cardId, acceptance, workspaceRef, targetCommit, freezeActivation });
}

export function handleCardReviewForAgent(cardId: string): void {
  enqueueReview(cardId);
}

export function handleCardSpecAndDesign(cardId: string, approval: MoveApproval): void {
  if (config.specDesignKickoffMode === "manual") {
    void commentOnCard(
      cardId,
      `${manualSpecMarker}${JSON.stringify(approval)} -->\nSpec & Design is ready for a local manual run. From the Orchestrator repo, run: \`npm run spec-design:manual -- --card-id ${cardId}\` with \`SPEC_DESIGN_KICKOFF_MODE=manual\`, \`SPEC_DESIGN_RUNTIME=local\`, \`SPEC_DESIGN_AGENT_PROVIDER=codex\`, and \`SPEC_DESIGN_AGENT_DIR\` set to the local Spec & Design Agent checkout.`,
    ).catch((err) => console.error(`[trello-orchestrator] Could not record the manual Spec & Design kickoff for ${cardId}:`, err));
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
    throw new Error("No recorded Spec & Design transition was found. Move the card into Spec & Design through the Orchestrator first.");
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
