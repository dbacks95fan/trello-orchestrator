// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Validates, deduplicates, and authorizes canonical Trello board transitions.
import type { LifecycleValidator } from "../contracts/lifecycle.js";
import type { TrelloCard, TrelloComment, WorkflowListIds } from "../trello/client.js";
import type { BoardTransitionEvent } from "../trello/webhookEvent.js";
import { resolveTransition } from "./transitionPolicy.js";
import type { ProductConfig } from "./specRequestFromCard.js";

const EVENT_MARKER = "<!-- agentic-sdlc-board-transition ";

export interface BoardTransitionDependencies {
  boardId: string;
  validator: LifecycleValidator;
  getCard(cardId: string): Promise<TrelloCard>;
  getCardComments(cardId: string): Promise<TrelloComment[]>;
  commentOnCard(cardId: string, text: string): Promise<void>;
  getProductConfig(card: TrelloCard): Promise<ProductConfig>;
  getWorkflowListIds(product: ProductConfig): Promise<WorkflowListIds>;
  dispatch(action: string, event: BoardTransitionEvent, card: TrelloCard): Promise<void>;
}

export interface BoardTransitionResult {
  disposition: "accepted" | "duplicate" | "blocked";
  reason?: string;
  action?: string;
}

const inFlight = new Set<string>();

function containsEvent(comments: TrelloComment[], eventId: string): boolean {
  return comments.some((comment) => {
    const text = comment.data?.text ?? "";
    if (!text.startsWith(EVENT_MARKER)) return false;
    const end = text.indexOf(" -->");
    if (end < 0) return false;
    try {
      return (JSON.parse(text.slice(EVENT_MARKER.length, end)) as { event_id?: string }).event_id === eventId;
    } catch {
      return false;
    }
  });
}

async function block(
  event: BoardTransitionEvent,
  deps: BoardTransitionDependencies,
  reason: string,
): Promise<BoardTransitionResult> {
  await deps.commentOnCard(
    event.card_id,
    `Transition blocked: ${reason}\n\nEvent ${event.event_id} needs human resolution.`,
  );
  return { disposition: "blocked", reason };
}

/** Verify event shape, board state, transition order, owner authority, and event idempotency before dispatch. */
export async function processBoardTransition(
  event: BoardTransitionEvent,
  deps: BoardTransitionDependencies,
): Promise<BoardTransitionResult> {
  if (inFlight.has(event.event_id)) return { disposition: "duplicate" };
  inFlight.add(event.event_id);
  try {
    const validation = deps.validator.validate("BoardTransitionEvent", event);
    if (!validation.valid) return block(event, deps, `Invalid BoardTransitionEvent: ${validation.errors.join("; ")}`);
    if (event.board_id !== deps.boardId)
      return block(event, deps, "The event board ID does not match the configured product board.");

    const card = await deps.getCard(event.card_id);
    if (card.idBoard !== event.board_id || card.idList !== event.to_list_id) {
      return block(event, deps, "The current Trello card board or list does not match the event destination.");
    }

    const priorComments = await deps.getCardComments(event.card_id);
    if (containsEvent(priorComments, event.event_id)) return { disposition: "duplicate" };

    const product = await deps.getProductConfig(card);
    const productValidation = deps.validator.validate("ProductConfig", product);
    if (!productValidation.valid) {
      return block(event, deps, `The product configuration is invalid: ${productValidation.errors.join("; ")}`);
    }
    if (product.trello_board_id !== event.board_id)
      return block(event, deps, "The product configuration belongs to a different board.");
    const listIds = await deps.getWorkflowListIds(product);
    const resolution = resolveTransition(event.from_list_id, event.to_list_id, listIds);
    await deps.commentOnCard(
      event.card_id,
      `${EVENT_MARKER}${JSON.stringify(event)} -->\nTransition observed: ${resolution.from ?? "unknown"} -> ${resolution.to ?? "unknown"}.`,
    );
    if (resolution.action === "invalid")
      return block(event, deps, "This move is not an authorized in-order lifecycle transition.");

    if (resolution.requiresProductOwner) {
      if (!product.authorized_product_owner_ids.includes(event.actor_id)) {
        return block(event, deps, "The Trello actor is not an authorized product owner for this product.");
      }
    }

    await deps.dispatch(resolution.action, event, card);
    return { disposition: "accepted", action: resolution.action };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await deps
      .commentOnCard(event.card_id, `Transition processing failed and needs human resolution: ${reason}`)
      .catch(() => undefined);
    return { disposition: "blocked", reason };
  } finally {
    inFlight.delete(event.event_id);
  }
}
