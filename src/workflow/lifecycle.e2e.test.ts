// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Exercises the documented board lifecycle through the local Orchestrator boundary.
import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { config } from "../config.js";
import type { TrelloCard, WorkflowListIds } from "../trello/client.js";
import { processBoardTransition } from "./boardTransition.js";
import type { BoardTransitionEvent } from "../trello/webhookEvent.js";

const validator = createLifecycleValidator(config.lifecycleSchemaPath);
const lists: WorkflowListIds = {
  newIdeas: "list-new",
  backlog: "list-backlog",
  prioritized: "list-prioritized",
  specDesign: "list-spec",
  execution: "list-execution",
  evaluation: "list-evaluation",
  humanApproval: "list-human-approval",
  release: "list-release",
  productionObservation: "list-observation",
  done: "list-done",
};

const product = {
  schema_version: "1.1" as const,
  product_id: "MF",
  product_name: "MealFlow",
  trello_board_id: "board-1",
  trello_lists: {
    new_ideas: lists.newIdeas,
    backlog: lists.backlog,
    prioritized: lists.prioritized,
    spec_design: lists.specDesign,
    execution: lists.execution,
    evaluation: lists.evaluation,
    human_approval: lists.humanApproval,
    release: lists.release,
    production_observation: lists.productionObservation,
    done: lists.done,
  },
  target_repository: "https://github.com/example/mealflow",
  authorized_product_owner_ids: ["owner-1"],
  policy_profiles: { "MF-DEFAULT": "products/mealflow/policy-profiles/default.md" },
};

test("runs the canonical happy-path transitions with schema-valid local test doubles", async () => {
  const card: TrelloCard = {
    id: "card-1",
    idBoard: "board-1",
    idShort: 1,
    name: "Meal planning improvement",
    desc: "",
    idList: lists.newIdeas,
    shortLink: "abc123",
    url: "https://trello.com/c/abc123",
  };
  const comments: Array<{ id: string; data: { text?: string } }> = [];
  const actions: string[] = [];
  let serial = 0;

  const edges: Array<[keyof WorkflowListIds, keyof WorkflowListIds, string]> = [
    ["newIdeas", "backlog", "owner-1"],
    ["backlog", "prioritized", "owner-1"],
    ["prioritized", "specDesign", "owner-1"],
    ["specDesign", "execution", "owner-1"],
    ["execution", "evaluation", "orchestrator-1"],
    ["evaluation", "humanApproval", "orchestrator-1"],
    ["humanApproval", "release", "owner-1"],
    ["release", "productionObservation", "orchestrator-1"],
    ["productionObservation", "done", "owner-1"],
  ];

  for (const [from, to, actor_id] of edges) {
    card.idList = lists[to];
    const event: BoardTransitionEvent = {
      schema_version: "1.0",
      event_id: `event-${++serial}`,
      event_type: "card_moved",
      board_id: "board-1",
      card_id: card.id,
      from_list_id: lists[from],
      to_list_id: lists[to],
      actor_id,
      occurred_at: `2026-10-26T12:00:${String(serial).padStart(2, "0")}.000Z`,
    };
    const result = await processBoardTransition(event, {
      boardId: "board-1",
      validator,
      getCard: async () => card,
      getCardComments: async () => comments,
      commentOnCard: async (_id, text) => {
        comments.push({ id: `comment-${comments.length + 1}`, data: { text } });
      },
      getProductConfig: async () => product,
      getWorkflowListIds: async () => lists,
      dispatch: async (action) => {
        actions.push(action);
      },
    });
    assert.equal(result.disposition, "accepted", `${from} -> ${to}: ${result.reason ?? ""}`);
  }

  assert.deepEqual(actions, [
    "capture_to_backlog",
    "activate_freeze",
    "start_spec_design",
    "accept_spec",
    "start_evaluation",
    "evaluation_pass",
    "human_approve_release",
    "release_observation",
    "observation_close",
  ]);
  assert.equal(comments.length, edges.length);
});
