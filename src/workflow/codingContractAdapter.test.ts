// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests the fail-closed conversion from canonical Work Contract v3 to Coding Agent v2.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { config } from "../config.js";
import type { TrelloCard } from "../trello/client.js";
import { adaptAcceptedWorkContract } from "./codingContractAdapter.js";
import type { WorkContractExpectation } from "./workContractV3.js";

const validator = createLifecycleValidator(config.lifecycleSchemaPath);
const expectation: WorkContractExpectation = {
  productId: "MF",
  intentId: "INT-MF-0042",
  intentVersion: 3,
  cardId: "card-1",
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

function fixture() {
  return {
    card: {
      id: "card-1",
      idBoard: "board-1",
      idShort: 12,
      name: "[Feature] Weekly plan",
      desc: "",
      idList: "execution",
      shortLink: "abc",
      url: "https://trello.com/c/abc",
    } satisfies TrelloCard,
    workContractV3: {
      schema_version: 3,
      work_item: { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 3, trello_card_id: "card-1" },
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
      acceptance_criteria: ["A person can plan a week of meals.", "The plan is saved."],
      permitted_scope: { included: ["Weekly meal planning"], excluded: ["Export"] },
      required_validation: [
        { name: "build", command: "npm run build" },
        { name: "automated_tests", command: "npm run test:server" },
      ],
      policy_controls: [
        { control_id: "SEC-1", required_action: "Avoid secret logging", evidence_expected: "Code review" },
      ],
      release_requirements: [],
      observation_requirements: [],
    },
    specMarkdown:
      "# Specification\n\n## Outcome and scope\nA person can create a weekly meal plan.\n\n## Acceptance criteria\n- The plan can be saved.\n",
    specAcceptance: {
      decision: "accepted_for_execution",
      authorized_by: "owner-1",
      recorded_at: "2026-10-26T12:00:00.000Z",
      work_item: { trello_card_id: "card-1" },
      spec: {
        repository: expectation.targetRepository,
        commit_sha: "c".repeat(40),
        path: "spec.md",
        sha256: "f".repeat(64),
      },
      work_contract: {
        repository: expectation.targetRepository,
        commit_sha: "c".repeat(40),
        path: "work-contract.yaml",
        sha256: "e".repeat(64),
      },
    },
  };
}

const input = (overrides: Partial<ReturnType<typeof fixture>> = {}) => {
  const values = { ...fixture(), ...overrides };
  const frozenIntentBytes = Buffer.from("frozen intent");
  const intentSha256 = createHash("sha256").update(frozenIntentBytes).digest("hex");
  (values.workContractV3.intent as Record<string, unknown>).sha256 = intentSha256;
  return {
    ...values,
    frozenIntentPath: ".agent/work/INT-MF-0042/intent.md",
    frozenIntentBytes,
    targetRepository: expectation.targetRepository,
    targetCommit: expectation.targetCommit,
    expected: { ...expectation, intentSha256 },
    validator,
  };
};

test("adapts accepted v3 intent, acceptance criteria, scope, and supported validation to Coding Agent v2", () => {
  const args = input();
  const contract = adaptAcceptedWorkContract(args);
  assert.equal(contract.schema_version, 2);
  assert.equal(contract.objective, "A person can create a weekly meal plan.");
  assert.deepEqual(contract.acceptance_criteria, {
    AC1: "A person can plan a week of meals.",
    AC2: "The plan is saved.",
  });
  assert.deepEqual(contract.required_validation, ["build", "automated_tests"]);
  assert.equal(contract.intent.path, ".agent/work/INT-MF-0042/intent.md");
  assert.deepEqual(contract.non_goals, ["Export"]);
});

test("blocks unsupported validation names, command mismatches, and missing outcome text", () => {
  const unsupported = input();
  (unsupported.workContractV3.required_validation as Array<{ name: string; command: string }>).push({
    name: "security_scan",
    command: "npm run security",
  });
  assert.throws(() => adaptAcceptedWorkContract(unsupported), /does not support/);

  const commandMismatch = input();
  commandMismatch.workContractV3.required_validation = [{ name: "build", command: "npm run custom-build" }];
  assert.throws(() => adaptAcceptedWorkContract(commandMismatch), /deterministically runs/);

  const noOutcome = input({ specMarkdown: "# Spec\n\n## Design\nDetails.\n" });
  assert.throws(() => adaptAcceptedWorkContract(noOutcome), /Outcome and scope/);
});
