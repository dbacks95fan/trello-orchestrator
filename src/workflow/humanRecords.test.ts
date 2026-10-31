// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests human record parsing and immutable Spec Acceptance verification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { config } from "../config.js";
import type { TrelloCard } from "../trello/client.js";
import { writeFreezeProjection } from "./freezeState.js";
import { parseHumanRecordComment, validateSpecAcceptanceRecord } from "./humanRecords.js";
import type { ProductConfig } from "./specRequestFromCard.js";

const validator = createLifecycleValidator(config.lifecycleSchemaPath);
const repo = "https://github.com/example/mealflow";
const intentRepo = "https://github.com/example/intent-backlog";
const intentCommit = "a".repeat(40);
const targetCommit = "b".repeat(40);
const artifactCommit = "c".repeat(40);
const intentHash = "d".repeat(64);
const profileHash = "e".repeat(64);
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const intentBytes = Buffer.from("canonical frozen intent bytes");
const frozenIntentHash = hash(intentBytes.toString("utf8"));
const contract = {
  schema_version: 3,
  work_item: { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 3, trello_card_id: "card-1" },
  intent: {
    repository: intentRepo,
    commit_sha: intentCommit,
    path: "products/mealflow/intents/INT-MF-0042/intent.md",
    sha256: frozenIntentHash,
  },
  policy_profile_id: "MF-DEFAULT",
  policy_profile_version: "1",
  policy_profile: {
    repository: intentRepo,
    commit_sha: intentCommit,
    path: "products/mealflow/policy-profiles/default.md",
    sha256: profileHash,
  },
  target: { repository: repo, commit_sha: targetCommit },
  acceptance_criteria: ["The user can make a weekly plan."],
  permitted_scope: { included: ["Weekly planning"], excluded: ["Export"] },
  required_validation: [{ name: "tests", command: "npm test" }],
  policy_controls: [],
  release_requirements: [],
  observation_requirements: [],
};
const spec = "# Spec\n\nAccepted behavior.\n";
const contractText = JSON.stringify(contract);
const productConfig: ProductConfig = {
  schema_version: "1.1",
  product_id: "MF",
  product_name: "MealFlow",
  trello_board_id: "board-1",
  trello_lists: {
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
  },
  target_repository: repo,
  authorized_product_owner_ids: ["owner-1"],
  policy_profiles: { "MF-DEFAULT": "products/mealflow/policy-profiles/default.md" },
};

function fixture() {
  const card: TrelloCard = {
    id: "card-1",
    idBoard: "board-1",
    idShort: 1,
    name: "Plan",
    desc: "",
    idList: "spec",
    shortLink: "abc",
    url: "https://trello.com/c/abc",
  };
  card.desc = writeFreezeProjection("", {
    state: "Active",
    tuple: {
      productId: "MF",
      intentId: "INT-MF-0042",
      intentVersion: 3,
      intentCommit,
      intentSha256: frozenIntentHash,
      policyProfileId: "MF-DEFAULT",
      policyProfileVersion: "1",
      policyProfileCommit: intentCommit,
      policyProfileSha256: profileHash,
      cardId: card.id,
      freezeEventId: "freeze-1",
      authorizedBy: "owner-1",
      frozenAt: "2026-10-26T10:00:00.000Z",
    },
  });
  const record = {
    schema_version: "1.0",
    work_item: { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 3, trello_card_id: card.id },
    decision: "accepted_for_execution",
    authorized_by: "owner-1",
    recorded_at: "2026-10-26T12:00:00.000Z",
    spec: { repository: repo, commit_sha: artifactCommit, path: "spec.md", sha256: hash(spec) },
    work_contract: {
      repository: repo,
      commit_sha: artifactCommit,
      path: "work-contract.yaml",
      sha256: hash(contractText),
    },
  };
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    return new Response(decodeURIComponent(url).includes("spec.md") ? spec : contractText);
  };
  return { card, record, fetchFn };
}

function expectedArtifacts(record: ReturnType<typeof fixture>["record"]) {
  return {
    expectedSpec: record.spec,
    expectedWorkContract: record.work_contract,
    expectedTargetCommit: targetCommit,
  };
}

test("parses a typed human-record comment", () => {
  assert.deepEqual(
    parseHumanRecordComment(
      '<!-- agentic-sdlc-human-record {"definition":"SpecAcceptanceRecord","record":{"decision":"accepted_for_execution"}} -->',
    ),
    {
      definition: "SpecAcceptanceRecord",
      record: { decision: "accepted_for_execution" },
    },
  );
  assert.equal(parseHumanRecordComment("ordinary comment"), null);
});

test("accepts only a human-approved record bound to the current freeze and committed artifact bytes", async () => {
  const { card, record, fetchFn } = fixture();
  const issues = await validateSpecAcceptanceRecord({
    card,
    actorId: "owner-1",
    record,
    validator,
    productConfig,
    ...expectedArtifacts(record),
    githubApiBase: "https://api.github.com",
    intentBacklogReadToken: "",
    productRepositoryReadToken: "",
    fetchFn,
    resolveIntent: async () =>
      ({
        productId: "MF",
        intentId: "INT-MF-0042",
        intentVersion: 3,
        intentCommit,
        intentContentSha256: intentHash,
        frozenIntentBytes: intentBytes,
        intentRepository: "example/intent-backlog",
        intentPath: "products/mealflow/intents/INT-MF-0042/intent.md",
        policyProfileId: "MF-DEFAULT",
        policyProfileVersion: "1",
        policyProfilePath: "products/mealflow/policy-profiles/default.md",
        policyProfileContentSha256: profileHash,
      }) as never,
  });
  assert.deepEqual(issues, []);
});

test("rejects a record from another actor and a hash-mismatched artifact", async () => {
  const { card, record, fetchFn } = fixture();
  const validationOptions = {
    card,
    record,
    validator,
    productConfig,
    ...expectedArtifacts(record),
    githubApiBase: "https://api.github.com",
    intentBacklogReadToken: "",
    productRepositoryReadToken: "",
    fetchFn,
    resolveIntent: async () =>
      ({
        productId: "MF",
        intentId: "INT-MF-0042",
        intentVersion: 3,
        intentCommit,
        intentContentSha256: intentHash,
        frozenIntentBytes: intentBytes,
        intentRepository: "example/intent-backlog",
        intentPath: "products/mealflow/intents/INT-MF-0042/intent.md",
        policyProfileId: "MF-DEFAULT",
        policyProfileVersion: "1",
        policyProfilePath: "products/mealflow/policy-profiles/default.md",
        policyProfileContentSha256: profileHash,
      }) as never,
  };
  assert.ok((await validateSpecAcceptanceRecord({ ...validationOptions, actorId: "intruder" })).length > 0);
  assert.ok(
    (
      await validateSpecAcceptanceRecord({
        ...validationOptions,
        actorId: "owner-1",
        record: { ...record, spec: { ...record.spec, sha256: "f".repeat(64) } },
      })
    ).some((issue) => issue.includes("hash mismatch")),
  );
});
