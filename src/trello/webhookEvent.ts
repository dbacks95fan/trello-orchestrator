// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Converts authenticated Trello card-move actions into the canonical transition event shape.
export interface BoardTransitionEvent {
  schema_version: "1.0";
  event_id: string;
  event_type: "card_moved";
  board_id: string;
  card_id: string;
  from_list_id: string;
  to_list_id: string;
  actor_id: string;
  occurred_at: string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Use Trello IDs at the control-plane boundary; names and list positions are presentation data. */
export function boardTransitionFromWebhook(payload: unknown): BoardTransitionEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const action = (payload as { action?: unknown }).action;
  if (!action || typeof action !== "object") return null;
  const a = action as Record<string, unknown>;
  if (a.type !== "updateCard") return null;
  const data = a.data && typeof a.data === "object" ? (a.data as Record<string, unknown>) : {};
  const card = data.card && typeof data.card === "object" ? (data.card as Record<string, unknown>) : {};
  const before =
    data.listBefore && typeof data.listBefore === "object" ? (data.listBefore as Record<string, unknown>) : {};
  const after = data.listAfter && typeof data.listAfter === "object" ? (data.listAfter as Record<string, unknown>) : {};
  const board = data.board && typeof data.board === "object" ? (data.board as Record<string, unknown>) : {};
  const member =
    a.memberCreator && typeof a.memberCreator === "object" ? (a.memberCreator as Record<string, unknown>) : {};
  const fromList = nonEmpty(before.id);
  const toList = nonEmpty(after.id);
  if (!fromList || !toList || fromList === toList) return null;
  const event: BoardTransitionEvent = {
    schema_version: "1.0",
    event_id: nonEmpty(a.id) ?? "",
    event_type: "card_moved",
    board_id: nonEmpty(board.id) ?? nonEmpty(card.idBoard) ?? "",
    card_id: nonEmpty(card.id) ?? "",
    from_list_id: fromList,
    to_list_id: toList,
    actor_id: nonEmpty(member.id) ?? "",
    occurred_at: nonEmpty(a.date) ?? "",
  };
  return event;
}
