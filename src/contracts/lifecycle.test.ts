// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Verifies runtime validation against the canonical lifecycle JSON Schema.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createLifecycleValidator } from "./lifecycle.js";

const schemaPath = resolve(process.cwd(), "..", "agentic-sdlc", "schemas", "lifecycle-contracts.schema.json");

test("loads the canonical Draft 2020-12 schema and validates a board transition by ID", () => {
  const validator = createLifecycleValidator(schemaPath);
  const result = validator.validate("BoardTransitionEvent", {
    schema_version: "1.0",
    event_id: "trello-action-1",
    event_type: "card_moved",
    board_id: "board-1",
    card_id: "card-1",
    from_list_id: "list-backlog",
    to_list_id: "list-prioritized",
    actor_id: "owner-1",
    occurred_at: "2026-10-26T12:00:00.000Z",
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("requires ProductConfig 1.1 to include every canonical stage list mapping", () => {
  const validator = createLifecycleValidator(schemaPath);
  const lists = {
    new_ideas: "list-new",
    backlog: "list-backlog",
    prioritized: "list-prioritized",
    spec_design: "list-spec",
    execution: "list-execution",
    evaluation: "list-evaluation",
    human_approval: "list-human-approval",
    release: "list-release",
    production_observation: "list-observation",
    done: "list-done",
  };
  const product = {
    schema_version: "1.1",
    product_id: "MF",
    product_name: "MealFlow",
    trello_board_id: "board-1",
    trello_lists: lists,
    target_repository: "https://github.com/example/mealflow",
    authorized_product_owner_ids: ["owner-1"],
    policy_profiles: { "MF-DEFAULT": "policy-profiles/default.md" },
  };
  assert.equal(validator.validate("ProductConfig", product).valid, true);
  assert.equal(validator.validate("ProductConfig", { ...product, schema_version: "1.0" }).valid, false);
  assert.equal(validator.validate("ProductConfig", { ...product, trello_lists: undefined }).valid, false);
});

test("rejects unsupported Work Contract versions and invalid date formats", () => {
  const validator = createLifecycleValidator(schemaPath);
  const invalidWorkContract = validator.validate("WorkContract", {
    schema_version: 2,
    work_item: {},
  });
  assert.equal(invalidWorkContract.valid, false);
  assert.ok(invalidWorkContract.errors.length > 0);

  const invalidEvent = validator.validate("BoardTransitionEvent", {
    schema_version: "1.0",
    event_id: "event-1",
    event_type: "card_moved",
    board_id: "board-1",
    card_id: "card-1",
    from_list_id: "list-1",
    to_list_id: "list-2",
    actor_id: "owner-1",
    occurred_at: "yesterday",
  });
  assert.equal(invalidEvent.valid, false);
});

test("validates freeze audit, stage invocation, and correlated stage result records", () => {
  const validator = createLifecycleValidator(schemaPath);
  const workItem = { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 3, trello_card_id: "card-1" };
  const artifact = {
    repository: "https://github.com/example/intent-backlog",
    commit_sha: "a".repeat(40),
    path: "products/mealflow/intents/INT-MF-0042/intent.md",
    sha256: "b".repeat(64),
  };
  const freezeActivation = {
    schema_version: "1.0",
    event_id: "trello-action-1",
    event_type: "activated",
    work_item: workItem,
    intent: artifact,
    policy_profile_id: "MF-DEFAULT",
    policy_profile_version: "1",
    policy_profile: { ...artifact, path: "products/mealflow/policy-profiles/default.md" },
    authorized_by: "owner-1",
    recorded_at: "2026-10-26T12:00:00.000Z",
  };
  const freeze = validator.validate("FreezeActivationEvent", freezeActivation);
  assert.equal(freeze.valid, true, freeze.errors.join("; "));

  const invocation = validator.validate("StageInvocation", {
    schema_version: "1.1",
    invocation_id: "invocation-1",
    trigger_event_id: "trello-action-2",
    stage: "spec_design",
    work_item: workItem,
    freeze_activation: freezeActivation,
    input_artifacts: [],
    target: { repository: "https://github.com/example/mealflow", commit_sha: "c".repeat(40) },
    workspace_ref: "work/INT-MF-0042",
    read_paths: ["."],
    write_paths: [".agent/work/INT-MF-0042"],
  });
  assert.equal(invocation.valid, true, invocation.errors.join("; "));
  const legacyInvocation = validator.validate("StageInvocation", {
    schema_version: "1.0",
    invocation_id: "invocation-1",
    trigger_event_id: "trello-action-2",
    stage: "spec_design",
    work_item: workItem,
    input_artifacts: [artifact],
    target: { repository: "https://github.com/example/mealflow", commit_sha: "c".repeat(40) },
    workspace_ref: "work/INT-MF-0042",
    read_paths: ["."],
    write_paths: [".agent/work/INT-MF-0042"],
  });
  assert.equal(legacyInvocation.valid, false);
  const result = validator.validate("StageResult", {
    schema_version: "1.0",
    invocation_id: "invocation-1",
    stage: "spec_design",
    work_item: workItem,
    status: "blocked",
    output_artifacts: [],
    summary: "The worker did not emit a Work Contract v3 reference.",
  });
  assert.equal(result.valid, true, result.errors.join("; "));
});
