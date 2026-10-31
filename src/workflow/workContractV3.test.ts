// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests Work Contract v3 schema and immutable-input binding checks.
import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { config } from "../config.js";
import { validateWorkContractV3, type WorkContractExpectation } from "./workContractV3.js";

const validator = createLifecycleValidator(config.lifecycleSchemaPath);
const expectation: WorkContractExpectation = {
  productId: "MF",
  intentId: "INT-MF-0042",
  intentVersion: 3,
  cardId: "card-123",
  intentRepository: "https://github.com/example/intent-backlog",
  intentCommit: "a".repeat(40),
  intentPath: "products/mealflow/intents/INT-MF-0042/intent.md",
  intentSha256: "d".repeat(64),
  policyProfileId: "MF-DEFAULT",
  policyProfileVersion: "1",
  policyProfilePath: "products/mealflow/policy-profiles/default.md",
  policyProfileSha256: "e".repeat(64),
  targetRepository: "https://github.com/example/mealflow",
  targetCommit: "b".repeat(40),
};

function validContract() {
  return {
    schema_version: 3,
    work_item: { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 3, trello_card_id: "card-123" },
    intent: {
      repository: expectation.intentRepository,
      commit_sha: expectation.intentCommit,
      path: expectation.intentPath,
      sha256: expectation.intentSha256,
    },
    policy_profile_id: "MF-DEFAULT",
    policy_profile_version: "1",
    policy_profile: {
      repository: expectation.intentRepository,
      commit_sha: expectation.intentCommit,
      path: expectation.policyProfilePath,
      sha256: expectation.policyProfileSha256,
    },
    target: { repository: expectation.targetRepository, commit_sha: expectation.targetCommit },
    acceptance_criteria: ["The user can plan a week of meals."],
    permitted_scope: { included: ["Weekly meal planning"], excluded: ["Shopping list export"] },
    required_validation: [{ name: "tests", command: "npm test" }],
    policy_controls: [],
    release_requirements: [],
    observation_requirements: [],
  };
}

test("accepts a schema-valid Work Contract v3 bound to the frozen inputs", () => {
  assert.deepEqual(validateWorkContractV3(validContract(), expectation, validator), []);
});

test("rejects legacy and mismatched work contracts", () => {
  const contract = validContract();
  contract.schema_version = 2;
  contract.work_item.intent_version = 4;
  const issues = validateWorkContractV3(contract, expectation, validator);
  assert.ok(issues.some((issue) => issue.includes("schema validation failed")));
  assert.ok(issues.some((issue) => issue.includes("work_item")));
});
