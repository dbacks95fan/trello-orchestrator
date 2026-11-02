// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Verifies Trello webhook normalization uses event and list IDs rather than display names, for moves and comments.
import assert from "node:assert/strict";
import test from "node:test";
import { boardTransitionFromWebhook, cardCommentFromWebhook } from "./webhookEvent.js";

test("normalizes a card move to the canonical ID-based event", () => {
  assert.deepEqual(
    boardTransitionFromWebhook({
      action: {
        id: "event-1",
        type: "updateCard",
        date: "2026-10-26T12:00:00.000Z",
        memberCreator: { id: "owner-1" },
        data: {
          board: { id: "board-1" },
          card: { id: "card-1", idBoard: "board-1" },
          listBefore: { id: "backlog-id", name: "Renamed backlog" },
          listAfter: { id: "prioritized-id", name: "Custom stage label" },
        },
      },
    }),
    {
      schema_version: "1.0",
      event_id: "event-1",
      event_type: "card_moved",
      board_id: "board-1",
      card_id: "card-1",
      from_list_id: "backlog-id",
      to_list_id: "prioritized-id",
      actor_id: "owner-1",
      occurred_at: "2026-10-26T12:00:00.000Z",
    },
  );
});

test("ignores non-card actions and card updates that are not list transitions", () => {
  assert.equal(boardTransitionFromWebhook({ action: { type: "commentCard" } }), null);
  assert.equal(boardTransitionFromWebhook({ action: { id: "event-2", type: "updateCard", data: {} } }), null);
});

test("normalizes a comment action, and ignores moves and incomplete comments", () => {
  const comment = {
    action: {
      id: "act-9",
      type: "commentCard",
      date: "2026-11-01T20:00:00.000Z",
      memberCreator: { id: "owner-1" },
      data: { text: "Deploy: production", card: { id: "card-1" }, board: { id: "board-1" } },
    },
  };
  assert.deepEqual(cardCommentFromWebhook(comment), {
    event_id: "act-9",
    board_id: "board-1",
    card_id: "card-1",
    comment_id: "act-9",
    actor_id: "owner-1",
    occurred_at: "2026-11-01T20:00:00.000Z",
    text: "Deploy: production",
  });
  assert.equal(boardTransitionFromWebhook(comment), null);
  assert.equal(cardCommentFromWebhook({ action: { ...comment.action, type: "updateCard" } }), null);
  assert.equal(cardCommentFromWebhook({ action: { ...comment.action, data: { card: { id: "card-1" } } } }), null);
  assert.equal(cardCommentFromWebhook({ action: { ...comment.action, memberCreator: {} } }), null);
  assert.equal(cardCommentFromWebhook(null), null);
});
