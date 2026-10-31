// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests that the Conductor builds and verifies the Spec Acceptance Record from the owner's board move.
import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { config } from "../config.js";
import type { TrelloCard, TrelloComment } from "../trello/client.js";
import { writeFreezeProjection } from "./freezeState.js";
import { parseHumanRecordComment } from "./humanRecords.js";
import { recordSpecAcceptance, specAcceptanceComment, type SpecAcceptanceCheck } from "./specAcceptance.js";

const validator = createLifecycleValidator(config.lifecycleSchemaPath);
const repo = "https://github.com/example/mealflow";
const intentRepo = "https://github.com/example/intent-backlog";
const intentCommit = "a".repeat(40);
const baseCommit = "b".repeat(40);
const intentHash = "d".repeat(64);
const profileHash = "e".repeat(64);
const workItem = { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 3, trello_card_id: "card-1" };
const moveTime = "2026-10-31T20:00:00.000Z";

const freezeActivation = {
  schema_version: "1.0",
  event_id: "freeze-1",
  event_type: "activated",
  work_item: workItem,
  intent: {
    repository: intentRepo,
    commit_sha: intentCommit,
    path: "products/mealflow/intents/INT-MF-0042/intent.md",
    sha256: intentHash,
  },
  policy_profile_id: "MF-DEFAULT",
  policy_profile_version: "1",
  policy_profile: {
    repository: intentRepo,
    commit_sha: intentCommit,
    path: "products/mealflow/policy-profiles/default.md",
    sha256: profileHash,
  },
  authorized_by: "owner-1",
  recorded_at: "2026-10-31T10:00:00.000Z",
};

function card(): TrelloCard {
  const value: TrelloCard = {
    id: "card-1",
    idBoard: "board-1",
    idShort: 1,
    name: "Plan",
    desc: "",
    idList: "list-execution",
    shortLink: "abc",
    url: "https://trello.com/c/abc",
  };
  value.desc = writeFreezeProjection("", {
    state: "Active",
    tuple: {
      productId: "MF",
      intentId: "INT-MF-0042",
      intentVersion: 3,
      intentCommit,
      intentSha256: intentHash,
      policyProfileId: "MF-DEFAULT",
      policyProfileVersion: "1",
      policyProfileCommit: intentCommit,
      policyProfileSha256: profileHash,
      cardId: value.id,
      freezeEventId: "freeze-1",
      authorizedBy: "owner-1",
      frozenAt: freezeActivation.recorded_at,
    },
  });
  return value;
}

function invocationComment(invocationId: string, date: string): TrelloComment {
  const invocation = {
    schema_version: "1.1",
    invocation_id: invocationId,
    trigger_event_id: `event-${invocationId}`,
    stage: "spec_design",
    work_item: workItem,
    freeze_activation: freezeActivation,
    input_artifacts: [],
    target: { repository: repo, commit_sha: baseCommit },
    workspace_ref: "work/INT-MF-0042",
    read_paths: ["."],
    write_paths: [".agent/work/INT-MF-0042"],
  };
  return {
    id: `c-${invocationId}`,
    date,
    data: { text: `<!-- agentic-sdlc-stage-invocation ${JSON.stringify(invocation)} -->\nrecorded` },
  };
}

function artifacts(commit: string) {
  return [
    { repository: repo, commit_sha: commit, path: ".agent/work/INT-MF-0042/spec.md", sha256: "1".repeat(64) },
    {
      repository: repo,
      commit_sha: commit,
      path: ".agent/work/INT-MF-0042/work-contract.yaml",
      sha256: "2".repeat(64),
    },
  ];
}

function resultComment(
  invocationId: string,
  status: string,
  date: string,
  overrides: Record<string, unknown> = {},
): TrelloComment {
  const result = {
    schema_version: "1.0",
    invocation_id: invocationId,
    stage: "spec_design",
    work_item: workItem,
    status,
    output_artifacts:
      status === "spec_ready" ? artifacts(invocationId === "run-2" ? "f".repeat(40) : "c".repeat(40)) : [],
    summary: status,
    ...overrides,
  };
  return {
    id: `r-${invocationId}`,
    date,
    data: { text: `<!-- agentic-sdlc-stage-result ${JSON.stringify(result)} -->\nrecorded` },
  };
}

function recordingVerify(issues: string[] = []) {
  const checks: SpecAcceptanceCheck[] = [];
  return {
    checks,
    verify: async (check: SpecAcceptanceCheck) => {
      checks.push(check);
      return issues;
    },
  };
}

test("builds the record from the owner's move and the latest spec_ready artifacts", async () => {
  const { checks, verify } = recordingVerify();
  const outcome = await recordSpecAcceptance({
    card: card(),
    comments: [
      resultComment("run-1", "spec_ready", "2026-10-31T11:00:00.000Z"),
      invocationComment("run-1", "2026-10-31T10:30:00.000Z"),
    ],
    actorId: "owner-1",
    recordedAt: moveTime,
    validator,
    verify,
  });

  assert.equal(outcome.accepted, true, outcome.accepted ? "" : outcome.reason);
  if (!outcome.accepted) return;
  assert.deepEqual(outcome.record, {
    schema_version: "1.0",
    work_item: workItem,
    decision: "accepted_for_execution",
    authorized_by: "owner-1",
    recorded_at: moveTime,
    spec: artifacts("c".repeat(40))[0],
    work_contract: artifacts("c".repeat(40))[1],
  });
  assert.ok(validator.validate("SpecAcceptanceRecord", outcome.record).valid);
  assert.equal(outcome.workspaceRef, "work/INT-MF-0042");
  assert.equal(outcome.targetCommit, baseCommit);
  assert.deepEqual(outcome.freezeActivation, freezeActivation);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].expectedTargetCommit, baseCommit);
  assert.deepEqual(checks[0].expectedSpec, outcome.record.spec);
});

test("accepts the newest spec_ready run when the spec was regenerated", async () => {
  const { verify } = recordingVerify();
  const outcome = await recordSpecAcceptance({
    card: card(),
    comments: [
      resultComment("run-1", "spec_ready", "2026-10-31T11:00:00.000Z"),
      invocationComment("run-1", "2026-10-31T10:30:00.000Z"),
      resultComment("run-2", "spec_ready", "2026-10-31T13:00:00.000Z"),
      invocationComment("run-2", "2026-10-31T12:30:00.000Z"),
    ],
    actorId: "owner-1",
    recordedAt: moveTime,
    validator,
    verify,
  });
  assert.equal(outcome.accepted, true);
  if (outcome.accepted) assert.equal((outcome.record.spec as Record<string, unknown>).commit_sha, "f".repeat(40));
});

test("refuses an older spec when the newest Spec & Design run did not produce one", async () => {
  const { checks, verify } = recordingVerify();
  const outcome = await recordSpecAcceptance({
    card: card(),
    comments: [
      resultComment("run-1", "spec_ready", "2026-10-31T11:00:00.000Z"),
      invocationComment("run-1", "2026-10-31T10:30:00.000Z"),
      resultComment("run-2", "blocked", "2026-10-31T13:00:00.000Z"),
    ],
    actorId: "owner-1",
    recordedAt: moveTime,
    validator,
    verify,
  });
  assert.equal(outcome.accepted, false);
  if (!outcome.accepted) assert.match(outcome.reason, /latest Spec & Design result is `blocked`/);
  assert.equal(checks.length, 0);
});

test("refuses a card without an active freeze", async () => {
  const unfrozen = { ...card(), desc: "" };
  const outcome = await recordSpecAcceptance({
    card: unfrozen,
    comments: [],
    actorId: "owner-1",
    recordedAt: moveTime,
    validator,
    verify: recordingVerify().verify,
  });
  assert.deepEqual(outcome, { accepted: false, reason: "The card does not have an active Prioritized freeze." });
});

test("refuses a card with no recorded Spec & Design result", async () => {
  const outcome = await recordSpecAcceptance({
    card: card(),
    comments: [{ id: "x", data: { text: "a human note" } }],
    actorId: "owner-1",
    recordedAt: moveTime,
    validator,
    verify: recordingVerify().verify,
  });
  assert.equal(outcome.accepted, false);
  if (!outcome.accepted) assert.match(outcome.reason, /No validated Spec & Design result/);
});

test("refuses a spec_ready result from another intent version", async () => {
  const outcome = await recordSpecAcceptance({
    card: card(),
    comments: [
      resultComment("run-1", "spec_ready", "2026-10-31T11:00:00.000Z", {
        work_item: { ...workItem, intent_version: 2 },
      }),
      invocationComment("run-1", "2026-10-31T10:30:00.000Z"),
    ],
    actorId: "owner-1",
    recordedAt: moveTime,
    validator,
    verify: recordingVerify().verify,
  });
  assert.equal(outcome.accepted, false);
  if (!outcome.accepted) assert.match(outcome.reason, /does not belong to the active Prioritized freeze/);
});

test("refuses a spec_ready result whose invocation is missing", async () => {
  const outcome = await recordSpecAcceptance({
    card: card(),
    comments: [resultComment("run-1", "spec_ready", "2026-10-31T11:00:00.000Z")],
    actorId: "owner-1",
    recordedAt: moveTime,
    validator,
    verify: recordingVerify().verify,
  });
  assert.equal(outcome.accepted, false);
  if (!outcome.accepted) assert.match(outcome.reason, /StageInvocation for the latest spec_ready result is missing/);
});

test("refuses when verification of authority, freeze, or artifact bytes fails", async () => {
  const outcome = await recordSpecAcceptance({
    card: card(),
    comments: [
      resultComment("run-1", "spec_ready", "2026-10-31T11:00:00.000Z"),
      invocationComment("run-1", "2026-10-31T10:30:00.000Z"),
    ],
    actorId: "intruder",
    recordedAt: moveTime,
    validator,
    verify: recordingVerify(["The actor is not an authorized product owner.", "Artifact hash mismatch for spec.md."])
      .verify,
  });
  assert.deepEqual(outcome, {
    accepted: false,
    reason: "The actor is not an authorized product owner.; Artifact hash mismatch for spec.md.",
  });
});

test("the recorded comment carries the record for audit", () => {
  const record = {
    schema_version: "1.0",
    spec: artifacts("c".repeat(40))[0],
    work_contract: artifacts("c".repeat(40))[1],
  };
  const comment = specAcceptanceComment(record);
  assert.deepEqual(parseHumanRecordComment(comment), { definition: "SpecAcceptanceRecord", record });
  assert.match(comment, /were accepted for Execution/);
});
