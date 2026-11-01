// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: The Release stage: the owner's "Deploy:" comment, checked against the merged pull request and the newest
// ABOUTME: approval, becomes a Deployment Authorization Record; the deploy service's report becomes the Release Record.
import { createHash } from "node:crypto";
import type { LifecycleValidator } from "../contracts/lifecycle.js";
import { DEPLOY_PREFIX, RATIONALE_PREFIX, type TrelloCard, type TrelloComment } from "../trello/client.js";
import type { CardCommentEvent } from "../trello/webhookEvent.js";
import { activeFreezeForCard } from "./freezeState.js";
import type { MergedPullRequest } from "./githubRead.js";
import { humanRecordComment } from "./humanApproval.js";
import { parseHumanRecordComment } from "./humanRecords.js";
import { latestStageRun, machineRecordComment, newestFirst, parseMachineRecord } from "./stageRecords.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

const DEPLOY_LINE = /^\s*deploy\s*:\s*([a-z0-9][a-z0-9_-]*)\s*$/i;

/** "Deploy: <environment>" on the first line and a "Rationale:" (or "Reason:") that runs to the end. */
export function parseDeployComment(text: string): Parsed<{ environment: string; rationale: string }> {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim());
  const environment = first >= 0 ? DEPLOY_LINE.exec(lines[first])?.[1] : undefined;
  if (!environment)
    return { ok: false, problem: "The first line must be `Deploy: <environment>`, such as `Deploy: production`." };
  const at = lines.findIndex((line, index) => index > first && RATIONALE_PREFIX.test(line));
  const rationale = at < 0 ? "" : [lines[at].replace(RATIONALE_PREFIX, ""), ...lines.slice(at + 1)].join("\n").trim();
  if (!rationale)
    return { ok: false, problem: "A deployment needs a written reason on a line that starts with `Rationale:`." };
  return { ok: true, value: { environment: environment.toLowerCase(), rationale } };
}

/** Canonical TrelloRecordRef: the comment's identity, its author, and a fingerprint of its exact text. */
export function trelloRecordRef(boardId: string, cardId: string, comment: TrelloComment): Record<string, unknown> {
  return {
    board_id: boardId,
    card_id: cardId,
    comment_id: comment.id,
    author_id: comment.idMemberCreator ?? "",
    content_sha256: createHash("sha256")
      .update(comment.data?.text ?? "", "utf8")
      .digest("hex"),
  };
}

/** The newest valid Human Approval Record on this card, and the comment that holds it. */
export function latestHumanApproval(
  comments: TrelloComment[],
  cardId: string,
  validator: LifecycleValidator,
): { record: Record<string, unknown>; comment: TrelloComment } | null {
  for (const comment of newestFirst(comments)) {
    const parsed = parseHumanRecordComment(comment.data?.text ?? "");
    if (parsed?.definition !== "HumanApprovalRecord") continue;
    const record = parsed.record as Record<string, unknown>;
    if (!validator.validate("HumanApprovalRecord", record).valid) continue;
    if ((record.work_item as Record<string, unknown>).trello_card_id !== cardId) continue;
    return { record, comment };
  }
  return null;
}

function releaseRecords(comments: TrelloComment[], validator: LifecycleValidator): Record<string, unknown>[] {
  return newestFirst(comments)
    .map((comment) => parseMachineRecord(comment.data?.text ?? "", "release-record"))
    .filter(
      (record): record is Record<string, unknown> =>
        record !== null && validator.validate("ReleaseRecord", record).valid,
    );
}

function authorizationFor(comments: TrelloComment[], commentId: string): boolean {
  return comments.some((comment) => {
    const parsed = parseHumanRecordComment(comment.data?.text ?? "");
    const ref = (parsed?.record as Record<string, unknown> | undefined)?.authorization_ref as
      Record<string, unknown> | undefined;
    return parsed?.definition === "DeploymentAuthorizationRecord" && ref?.comment_id === commentId;
  });
}

export interface IntegrationReads {
  mergedPulls(head: string, base: string): Promise<MergedPullRequest[]>;
  parentsOf(commit: string): Promise<string[]>;
  onBranch(commit: string, branch: string): Promise<boolean>;
}

/**
 * The integration commit for the approved candidate: the newest merged pull request from the work branch must have
 * merged exactly the evaluated commit, with a merge commit whose second parent is that commit, now on main.
 */
export async function integrationCommit(
  reads: IntegrationReads,
  workBranch: string,
  integrationBranch: string,
  evaluatedCommit: string,
): Promise<Parsed<{ sha: string; pull: number }>> {
  const [pull] = await reads.mergedPulls(workBranch, integrationBranch);
  if (!pull) {
    return {
      ok: false,
      problem: `No merged pull request from \`${workBranch}\` into \`${integrationBranch}\` was found. Merge it with **Create a merge commit**, then comment again.`,
    };
  }
  if (pull.headSha !== evaluatedCommit) {
    return {
      ok: false,
      problem: `Pull request #${pull.number} merged \`${pull.headSha.slice(0, 12)}\`, not the evaluated and approved \`${evaluatedCommit.slice(0, 12)}\`. A changed candidate needs a new evaluation and approval before it is deployed.`,
    };
  }
  const parents = await reads.parentsOf(pull.mergeCommitSha);
  if (parents.length !== 2 || parents[1] !== pull.headSha) {
    return {
      ok: false,
      problem: `Pull request #${pull.number} was not merged with a merge commit (squash or rebase), so the merged result cannot be tied to the approved candidate. Revert it and merge again with **Create a merge commit**.`,
    };
  }
  if (!(await reads.onBranch(pull.mergeCommitSha, integrationBranch))) {
    return {
      ok: false,
      problem: `Merge commit \`${pull.mergeCommitSha.slice(0, 12)}\` is no longer on \`${integrationBranch}\`.`,
    };
  }
  return { ok: true, value: { sha: pull.mergeCommitSha, pull: pull.number } };
}

export interface DeploymentOutcome {
  report: Record<string, unknown> | null;
  error: string | null;
}

export interface ReleaseDeps {
  getCard(cardId: string): Promise<TrelloCard>;
  getCardComments(cardId: string): Promise<TrelloComment[]>;
  commentOnCard(cardId: string, text: string): Promise<void>;
  /** The product's board configuration, for its authorized owners. */
  productOwners(card: TrelloCard): Promise<string[]>;
  integrationReads(repositoryUrl: string): Promise<IntegrationReads>;
  deploy(request: Record<string, unknown>): Promise<DeploymentOutcome>;
  /** False when no deploy service is configured. */
  deployConfigured: boolean;
  releaseListId: string;
  boardId: string;
  integrationBranch: string;
  validator: LifecycleValidator;
  now?: () => Date;
}

const REPORT_STATUSES = new Set(["released", "rolled_back", "failed", "blocked"]);

/** Builds the canonical Release Record from the deploy service's report; null with a reason if it cannot. */
export function releaseRecordFrom(input: {
  approval: Record<string, unknown>;
  approvalRef: Record<string, unknown>;
  authorization: Record<string, unknown>;
  report: Record<string, unknown>;
  recordedAt: string;
  validator: LifecycleValidator;
}): Parsed<Record<string, unknown>> {
  const { report } = input;
  if (!REPORT_STATUSES.has(String(report.status))) {
    return { ok: false, problem: `The deploy service reported an unknown status ${String(report.status)}.` };
  }
  const record: Record<string, unknown> = {
    schema_version: "1.1",
    work_item: input.approval.work_item,
    candidate: input.approval.candidate,
    integration: input.authorization.integration,
    approval_record: input.approvalRef,
    deployment_authorization: input.authorization,
    environment: input.authorization.environment,
    recorded_at: input.recordedAt,
    actions: report.actions,
    verification: report.verification,
    ...(typeof report.rollback === "string" ? { rollback: report.rollback } : {}),
    status: report.status,
    summary: report.summary,
  };
  const check = input.validator.validate("ReleaseRecord", record);
  if (!check.valid) return { ok: false, problem: `The Release Record is invalid: ${check.errors.join("; ")}` };
  return { ok: true, value: record };
}

const RETRY = "Fix it, then comment `Deploy: production` with a `Rationale:` again.";

/** Handles one owner comment that starts with "Deploy:". Every refusal is explained on the card. */
export async function handleDeployComment(event: CardCommentEvent, deps: ReleaseDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const refuse = (reason: string) => deps.commentOnCard(event.card_id, `⛔ Not deployed: ${reason}`);

  const card = await deps.getCard(event.card_id);
  const comments = await deps.getCardComments(card.id);
  // Re-read the comment from Trello: the webhook's copy is a hint, and the record fingerprints what Trello holds now.
  const comment = comments.find((c) => c.id === event.comment_id);
  if (!comment || !DEPLOY_PREFIX.test(comment.data?.text ?? "")) return;
  if (authorizationFor(comments, comment.id)) return; // A repeated webhook delivery.

  if (card.idList !== deps.releaseListId) return refuse("the card is not in Release.");
  const owners = await deps.productOwners(card);
  if (!comment.idMemberCreator || !owners.includes(comment.idMemberCreator)) {
    return refuse("only an authorized product owner can authorize a deployment.");
  }
  const parsed = parseDeployComment(comment.data?.text ?? "");
  if (!parsed.ok) return refuse(`${parsed.problem} ${RETRY}`);
  if (!deps.deployConfigured)
    return refuse("no deploy service is configured for this Orchestrator (DEPLOY_SERVICE_API_URL).");
  if (!activeFreezeForCard(card)) return refuse("the card does not have an active Prioritized freeze.");

  const approval = latestHumanApproval(comments, card.id, deps.validator);
  if (!approval || approval.record.decision !== "approved_for_integration_and_release") {
    return refuse("the newest Human Approval Record on this card is not an approval for integration and release.");
  }
  const candidate = approval.record.candidate as Record<string, unknown>;
  if (
    releaseRecords(comments, deps.validator).some(
      (r) => r.status === "released" && (r.candidate as Record<string, unknown>).commit_sha === candidate.commit_sha,
    )
  ) {
    return refuse("this candidate is already released. Move the card to Production Observation.");
  }
  const evaluation = latestStageRun(comments, "evaluation", card.id, deps.validator);
  if (!evaluation) return refuse("the card has no recorded evaluation run to find the work branch from.");

  const repository = String(candidate.repository);
  const evaluatedCommit = String((approval.record.evaluation as Record<string, unknown>).commit_sha);
  const integration = await integrationCommit(
    await deps.integrationReads(repository),
    String(evaluation.invocation.workspace_ref),
    deps.integrationBranch,
    evaluatedCommit,
  );
  if (!integration.ok) return refuse(integration.problem);

  const boardId = card.idBoard ?? deps.boardId;
  const authorization: Record<string, unknown> = {
    schema_version: "1.0",
    work_item: approval.record.work_item,
    integration: { repository, commit_sha: integration.value.sha },
    environment: parsed.value.environment,
    authorized_by: comment.idMemberCreator,
    recorded_at: comment.date ?? event.occurred_at,
    authorization_ref: trelloRecordRef(boardId, card.id, comment),
    rationale: parsed.value.rationale,
  };
  const authorizationCheck = deps.validator.validate("DeploymentAuthorizationRecord", authorization);
  if (!authorizationCheck.valid) {
    return refuse(`the Deployment Authorization Record is invalid: ${authorizationCheck.errors.join("; ")}`);
  }
  const integrationSha = integration.value.sha.slice(0, 12);
  await deps.commentOnCard(
    card.id,
    humanRecordComment(
      "DeploymentAuthorizationRecord",
      authorization,
      `🚀 Deployment Authorization Record: **${parsed.value.environment}** for merge commit \`${integrationSha}\` (pull request #${integration.value.pull}). Deploying now.`,
    ),
  );

  const outcome = await deps.deploy({
    schema_version: "1.0",
    deployment_id: `deploy-${comment.id}`,
    work_item: approval.record.work_item,
    integration: authorization.integration,
    environment: parsed.value.environment,
    deployment_authorization: authorization,
  });
  if (!outcome.report) {
    await deps.commentOnCard(
      card.id,
      `❌ The deploy service did not return a result: ${outcome.error ?? "no report"}. The outcome is unknown; check the product before deploying again. The card stays in Release.`,
    );
    return;
  }
  const release = releaseRecordFrom({
    approval: approval.record,
    approvalRef: trelloRecordRef(boardId, card.id, approval.comment),
    authorization,
    report: outcome.report,
    recordedAt: now().toISOString(),
    validator: deps.validator,
  });
  if (!release.ok) {
    await deps.commentOnCard(
      card.id,
      `❌ The deployment finished as **${String(outcome.report.status)}**, but no Release Record could be written: ${release.problem} The card stays in Release for triage.`,
    );
    return;
  }
  const status = String(release.value.status);
  const summary = String(release.value.summary);
  const notes: Record<string, string> = {
    released: `✅ Released: \`${integrationSha}\` is running in ${parsed.value.environment} and healthy. ${summary} Move the card to Production Observation when you are ready.`,
    rolled_back: `↩️ Rolled back: ${summary} The previous version is running. The card stays in Release for triage.`,
    failed: `❌ Release failed: ${summary} The card stays in Release for triage.`,
    blocked: `⏸️ Release blocked: ${summary} ${RETRY}`,
  };
  await deps.commentOnCard(card.id, machineRecordComment("release-record", release.value, notes[status]));
}
