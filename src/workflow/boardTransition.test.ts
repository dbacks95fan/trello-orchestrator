// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Verifies board transition gates use current Trello state and authorized identities.
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import type { TrelloCard, TrelloComment, WorkflowListIds } from "../trello/client.js";
import type { BoardTransitionEvent } from "../trello/webhookEvent.js";
import { processBoardTransition } from "./boardTransition.js";

const validator = createLifecycleValidator(
  resolve(process.cwd(), "..", "agentic-sdlc", "schemas", "lifecycle-contracts.schema.json"),
);
const listIds: WorkflowListIds = {
  newIdeas: "list-new",
  backlog: "list-backlog",
  prioritized: "list-prioritized",
  specDesign: "list-spec",
  execution: "list-execution",
  evaluation: "list-evaluation",
  humanApproval: "list-approval",
  release: "list-release",
  productionObservation: "list-observation",
  done: "list-done",
};

let testEventNumber = 0;

function fixture(actorId = "owner-1", destination = listIds.prioritized) {
  const comments: TrelloComment[] = [];
  const dispatched: string[] = [];
  const card: TrelloCard = {
    id: "card-1",
    idBoard: "board-1",
    idList: destination,
    idShort: 1,
    name: "Work",
    desc: "",
    shortLink: "c1",
    url: "https://trello.com/c/c1",
  };
  const event: BoardTransitionEvent = {
    schema_version: "1.0",
    event_id: `event-${++testEventNumber}`,
    event_type: "card_moved",
    board_id: "board-1",
    card_id: card.id,
    from_list_id: listIds.backlog,
    to_list_id: destination,
    actor_id: actorId,
    occurred_at: "2026-10-26T12:00:00.000Z",
  };
  const deps = {
    boardId: "board-1",
    listIds,
    validator,
    getCard: async () => card,
    getCardComments: async () => comments,
    commentOnCard: async (cardId: string, text: string) => {
      assert.equal(cardId, card.id);
      comments.push({ id: String(comments.length + 1), data: { text } });
    },
    getProductConfig: async () => ({
      schema_version: "1.1" as const,
      product_id: "MF",
      product_name: "MealFlow",
      trello_board_id: "board-1",
      trello_lists: {
        new_ideas: listIds.newIdeas,
        backlog: listIds.backlog,
        prioritized: listIds.prioritized,
        spec_design: listIds.specDesign,
        execution: listIds.execution,
        evaluation: listIds.evaluation,
        human_approval: listIds.humanApproval,
        release: listIds.release,
        production_observation: listIds.productionObservation,
        done: listIds.done,
      },
      target_repository: "https://github.com/example/mealflow",
      authorized_product_owner_ids: ["owner-1"],
      policy_profiles: { "MF-DEFAULT": "policy-profiles/default.md" },
    }),
    getWorkflowListIds: async () => listIds,
    dispatch: async (action: string) => {
      dispatched.push(action);
    },
  };
  return { event, deps, comments, dispatched };
}

test("accepts and records an owner transition once, then ignores duplicate delivery", async () => {
  const state = fixture();
  const first = await processBoardTransition(state.event, state.deps);
  const second = await processBoardTransition(state.event, state.deps);
  assert.equal(first.disposition, "accepted");
  assert.equal(first.action, "activate_freeze");
  assert.equal(second.disposition, "duplicate");
  assert.deepEqual(state.dispatched, ["activate_freeze"]);
  assert.equal(state.comments.length, 1);
});

test("blocks an unauthorized actor and an out-of-order board move", async () => {
  const unauthorized = fixture("other-user");
  const result = await processBoardTransition(unauthorized.event, unauthorized.deps);
  assert.equal(result.disposition, "blocked");
  assert.match(result.reason ?? "", /not an authorized product owner/);
  assert.deepEqual(unauthorized.dispatched, []);

  const skipped = fixture("owner-1", listIds.execution);
  const skippedResult = await processBoardTransition(skipped.event, skipped.deps);
  assert.equal(skippedResult.disposition, "blocked");
  assert.match(skippedResult.reason ?? "", /not an authorized/);
  assert.deepEqual(skipped.dispatched, []);
});
