// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Reads and writes the schema-validated StageInvocation, StageResult, and StageResultDecision card comments.
// ABOUTME: The card comments are the Conductor's durable record of every stage run; the newest one wins.
import type { LifecycleValidator } from "../contracts/lifecycle.js";
import type { TrelloComment } from "../trello/client.js";

export type MachineRecordKind = "stage-invocation" | "stage-result" | "stage-result-decision";

export function parseMachineRecord(text: string, kind: MachineRecordKind): Record<string, unknown> | null {
  const marker = `<!-- agentic-sdlc-${kind} `;
  if (!text.startsWith(marker)) return null;
  const end = text.indexOf(" -->");
  if (end < 0) return null;
  try {
    const value = JSON.parse(text.slice(marker.length, end)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Newest first by Trello's action time. Trello already lists actions newest first, so without times keep that order. */
export function newestFirst(comments: TrelloComment[]): TrelloComment[] {
  const timed = comments.every((comment) => comment.date && !Number.isNaN(Date.parse(comment.date)));
  if (!timed) return comments;
  return [...comments].sort((a, b) => Date.parse(b.date!) - Date.parse(a.date!));
}

export function machineRecordComment(kind: MachineRecordKind, record: Record<string, unknown>, note: string): string {
  return `<!-- agentic-sdlc-${kind} ${JSON.stringify(record)} -->\n${note}`;
}

export interface StageRun {
  invocation: Record<string, unknown>;
  result: Record<string, unknown>;
}

/**
 * The newest schema-valid StageResult for a stage on this card, paired with the
 * schema-valid StageInvocation that has the same invocation ID. Null when either is missing.
 */
export function latestStageRun(
  comments: TrelloComment[],
  stage: "spec_design" | "execution" | "evaluation",
  cardId: string,
  validator: LifecycleValidator,
): StageRun | null {
  const ordered = newestFirst(comments);
  const result = ordered
    .map((comment) => parseMachineRecord(comment.data?.text ?? "", "stage-result"))
    .find(
      (record) =>
        record !== null &&
        record.stage === stage &&
        validator.validate("StageResult", record).valid &&
        (record.work_item as Record<string, unknown>).trello_card_id === cardId,
    );
  if (!result) return null;
  const invocation = ordered
    .map((comment) => parseMachineRecord(comment.data?.text ?? "", "stage-invocation"))
    .find((record) => record?.invocation_id === result.invocation_id);
  if (!invocation || !validator.validate("StageInvocation", invocation).valid) return null;
  return { invocation, result };
}

/** Every schema-valid StageResult for a stage on this card, newest first. */
export function stageResults(
  comments: TrelloComment[],
  stage: "spec_design" | "execution" | "evaluation",
  cardId: string,
  validator: LifecycleValidator,
): Record<string, unknown>[] {
  return newestFirst(comments)
    .map((comment) => parseMachineRecord(comment.data?.text ?? "", "stage-result"))
    .filter(
      (record): record is Record<string, unknown> =>
        record !== null &&
        record.stage === stage &&
        validator.validate("StageResult", record).valid &&
        (record.work_item as Record<string, unknown>).trello_card_id === cardId,
    );
}
