// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Records the Human Approval Record (and a Closure Record for a stop) when the product owner moves a card
// ABOUTME: out of Human Approval. The move is the decision; the Conductor binds it to the newest verified pass.
import type { LifecycleValidator } from "../contracts/lifecycle.js";
import { HUMAN_DECISION_PREFIX, type TrelloCard, type TrelloComment } from "../trello/client.js";
import { activeFreezeForCard } from "./freezeState.js";
import { HUMAN_RECORD_MARKER } from "./humanRecords.js";
import { latestStageRun, newestFirst, parseMachineRecord } from "./stageRecords.js";

export type HumanApprovalDecision =
  "approved_for_integration_and_release" | "return_to_execution" | "return_to_spec_and_design" | "stopped";

export interface HumanApprovalInput {
  card: TrelloCard;
  comments: TrelloComment[];
  /** Trello member who moved the card; becomes `authorized_by`. */
  actorId: string;
  /** Time of the move; becomes `recorded_at`. */
  recordedAt: string;
  decision: HumanApprovalDecision;
  /** Board label of the destination, used in the instructions when no rationale was written. */
  destination: string;
  validator: LifecycleValidator;
}

export type HumanApprovalOutcome =
  | { recorded: true; record: Record<string, unknown>; closure: Record<string, unknown> | null }
  | { recorded: false; reason: string };

/**
 * The owner's written reason: their newest comment starting with "Rationale:" or "Reason:", written after the
 * evaluation result. The canonical record requires a rationale, so there is no default.
 */
function rationaleFor(comments: TrelloComment[], actorId: string, after: string | undefined): string | null {
  const written = newestFirst(comments).find(
    (comment) =>
      comment.idMemberCreator === actorId &&
      HUMAN_DECISION_PREFIX.test(comment.data?.text ?? "") &&
      (!after || !comment.date || Date.parse(comment.date) > Date.parse(after)),
  );
  return written?.data?.text?.replace(HUMAN_DECISION_PREFIX, "").trim() || null;
}

export function humanRecordComment(definition: string, record: Record<string, unknown>, note: string): string {
  return `${HUMAN_RECORD_MARKER}${JSON.stringify({ definition, record })} -->\n${note}`;
}

/** Builds and validates the records for a move out of Human Approval; refuses unless a verified pass is behind it. */
export function recordHumanApproval(input: HumanApprovalInput): HumanApprovalOutcome {
  const { card, comments, validator } = input;
  const freeze = activeFreezeForCard(card);
  if (!freeze) return { recorded: false, reason: "The card does not have an active Prioritized freeze." };

  const evaluation = latestStageRun(comments, "evaluation", card.id, validator);
  if (!evaluation || evaluation.result.status !== "pass") {
    return {
      recorded: false,
      reason: "The newest evaluation on this card is not a pass, so there is no candidate to decide on.",
    };
  }
  const accepted = comments.some((comment) => {
    const decision = parseMachineRecord(comment.data?.text ?? "", "stage-result-decision");
    return (
      decision !== null &&
      decision.invocation_id === evaluation.result.invocation_id &&
      decision.disposition === "accepted"
    );
  });
  if (!accepted)
    return { recorded: false, reason: "The newest passing evaluation has no accepted StageResultDecision." };
  if ((evaluation.invocation.freeze_activation as Record<string, unknown>).event_id !== freeze.tuple.freezeEventId) {
    return { recorded: false, reason: "The newest passing evaluation belongs to a freeze that is no longer active." };
  }

  const work = `.agent/work/${String((evaluation.invocation.work_item as Record<string, unknown>).intent_id)}`;
  const evidence = (evaluation.invocation.input_artifacts as Record<string, unknown>[]).find((ref) =>
    String(ref.path).startsWith(`${work}/evidence-package/`),
  );
  const evaluationRef = (evaluation.result.output_artifacts as Record<string, unknown>[])[0];
  if (!evidence || !evaluationRef || !evaluation.result.candidate) {
    return {
      recorded: false,
      reason: "The passing evaluation does not name its candidate, Evidence Package, and Evaluation Package.",
    };
  }
  const evaluatedAt = newestFirst(comments).find(
    (comment) =>
      parseMachineRecord(comment.data?.text ?? "", "stage-result")?.invocation_id === evaluation.result.invocation_id,
  )?.date;
  const rationale = rationaleFor(comments, input.actorId, evaluatedAt);
  if (!rationale) {
    return {
      recorded: false,
      reason: `No rationale was written. Add a comment that starts with "Rationale:" and explains the decision, move the card back to Human Approval, then move it to ${input.destination} again.`,
    };
  }

  const record = {
    schema_version: "1.0",
    work_item: evaluation.result.work_item,
    candidate: evaluation.result.candidate,
    evidence,
    evaluation: evaluationRef,
    decision: input.decision,
    authorized_by: input.actorId,
    recorded_at: input.recordedAt,
    rationale,
  };
  const recordCheck = validator.validate("HumanApprovalRecord", record);
  if (!recordCheck.valid)
    return { recorded: false, reason: `HumanApprovalRecord is invalid: ${recordCheck.errors.join("; ")}` };

  let closure: Record<string, unknown> | null = null;
  if (input.decision === "stopped") {
    closure = {
      schema_version: "1.0",
      work_item: evaluation.result.work_item,
      outcome: "stopped",
      latest_artifact: evaluationRef,
      authorized_by: input.actorId,
      recorded_at: input.recordedAt,
      reason: rationale,
    };
    const closureCheck = validator.validate("ClosureRecord", closure);
    if (!closureCheck.valid)
      return { recorded: false, reason: `ClosureRecord is invalid: ${closureCheck.errors.join("; ")}` };
  }
  return { recorded: true, record, closure };
}
