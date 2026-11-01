// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests recording Human Approval and Closure Records from the owner's move out of Human Approval.
import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { config } from "../config.js";
import type { TrelloCard, TrelloComment } from "../trello/client.js";
import { writeFreezeProjection } from "./freezeState.js";
import { recordHumanApproval, type HumanApprovalDecision } from "./humanApproval.js";
import { machineRecordComment } from "./stageRecords.js";

const validator = createLifecycleValidator(config.lifecycleSchemaPath);
const repo = "https://github.com/example/mealflow";
const work = ".agent/work/INT-MF-0042";
const workItem = { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 3, trello_card_id: "card-1" };
const sha = (c: string) => c.repeat(40);
const freeze = {
  schema_version: "1.0",
  event_id: "freeze-1",
  event_type: "activated",
  work_item: workItem,
  intent: {
    repository: "https://github.com/example/intent-backlog",
    commit_sha: sha("a"),
    path: "i.md",
    sha256: "1".repeat(64),
  },
  policy_profile_id: "MF-DEFAULT",
  policy_profile_version: "1",
  policy_profile: {
    repository: "https://github.com/example/intent-backlog",
    commit_sha: sha("a"),
    path: "p.md",
    sha256: "2".repeat(64),
  },
  authorized_by: "owner-1",
  recorded_at: "2026-10-27T11:00:00.000Z",
};
const evidenceRef = {
  repository: repo,
  commit_sha: sha("d"),
  path: `${work}/evidence-package/inv-x.json`,
  sha256: "5".repeat(64),
};
const packageRef = {
  repository: repo,
  commit_sha: sha("e"),
  path: `${work}/evaluation-package/inv-eval.json`,
  sha256: "6".repeat(64),
};

function card(freezeEventId = "freeze-1"): TrelloCard {
  const base: TrelloCard = {
    id: "card-1",
    idShort: 1,
    name: "Weekly plan",
    desc: "",
    idList: "list-human",
    shortLink: "x",
    url: "u",
  };
  base.desc = writeFreezeProjection("", {
    state: "Active",
    tuple: {
      productId: "MF",
      intentId: "INT-MF-0042",
      intentVersion: 3,
      intentCommit: sha("a"),
      intentSha256: "1".repeat(64),
      policyProfileId: "MF-DEFAULT",
      policyProfileVersion: "1",
      policyProfileCommit: sha("a"),
      policyProfileSha256: "2".repeat(64),
      cardId: "card-1",
      freezeEventId,
      authorizedBy: "owner-1",
      frozenAt: "2026-10-27T11:00:00.000Z",
    },
  });
  return base;
}

function evaluationComments(status = "pass", disposition = "accepted"): TrelloComment[] {
  const invocation = {
    schema_version: "1.1",
    invocation_id: "inv-eval",
    trigger_event_id: "evt",
    stage: "evaluation",
    work_item: workItem,
    freeze_activation: freeze,
    input_artifacts: [evidenceRef],
    target: { repository: repo, commit_sha: sha("d") },
    workspace_ref: "work/INT-MF-0042",
    read_paths: ["."],
    write_paths: [`${work}/evaluation-package`],
  };
  const result = {
    schema_version: "1.0",
    invocation_id: "inv-eval",
    stage: "evaluation",
    work_item: workItem,
    status,
    output_artifacts: [packageRef],
    candidate: { repository: repo, commit_sha: sha("c") },
    summary: "Evaluated.",
  };
  const decision = {
    schema_version: "1.0",
    invocation_id: "inv-eval",
    stage: "evaluation",
    work_item: workItem,
    result: packageRef,
    disposition,
    recorded_at: "2026-11-01T01:00:00.000Z",
    ...(disposition === "rejected" ? { reason: "x" } : {}),
  };
  return [
    {
      id: "1",
      date: "2026-11-01T00:50:00.000Z",
      data: { text: machineRecordComment("stage-invocation", invocation, "") },
    },
    { id: "2", date: "2026-11-01T00:59:00.000Z", data: { text: machineRecordComment("stage-result", result, "") } },
    {
      id: "3",
      date: "2026-11-01T01:00:00.000Z",
      data: { text: machineRecordComment("stage-result-decision", decision, "") },
    },
  ];
}

function record(decision: HumanApprovalDecision, comments: TrelloComment[], theCard = card()) {
  return recordHumanApproval({
    card: theCard,
    comments,
    actorId: "owner-1",
    recordedAt: "2026-11-01T09:00:00.000Z",
    decision,
    destination: "Release",
    validator,
  });
}

test("an approval binds the owner's move to the newest verified pass", () => {
  const outcome = record("approved_for_integration_and_release", evaluationComments());
  assert.equal(outcome.recorded, true);
  if (!outcome.recorded) return;
  assert.deepEqual(validator.validate("HumanApprovalRecord", outcome.record).errors, []);
  assert.deepEqual(outcome.record.candidate, { repository: repo, commit_sha: sha("c") });
  assert.deepEqual(outcome.record.evidence, evidenceRef);
  assert.deepEqual(outcome.record.evaluation, packageRef);
  assert.equal(outcome.record.authorized_by, "owner-1");
  assert.match(
    String(outcome.record.rationale),
    /No written rationale was given; recorded from the product owner's move/,
  );
  assert.equal(outcome.closure, null);
});

test("the owner's own Rationale comment written after the evaluation becomes the rationale", () => {
  const comments = [
    ...evaluationComments(),
    { id: "4", date: "2026-11-01T00:10:00.000Z", idMemberCreator: "owner-1", data: { text: "Rationale: too early" } },
    {
      id: "5",
      date: "2026-11-01T08:00:00.000Z",
      idMemberCreator: "someone-else",
      data: { text: "Rationale: not theirs" },
    },
    {
      id: "6",
      date: "2026-11-01T08:30:00.000Z",
      idMemberCreator: "owner-1",
      data: { text: "Rationale: Ship it; QA checked the plan view." },
    },
  ];
  const outcome = record("approved_for_integration_and_release", comments);
  assert.equal(outcome.recorded && outcome.record.rationale, "Ship it; QA checked the plan view.");
});

test("a stop also records a valid Closure Record", () => {
  const comments = [
    ...evaluationComments(),
    {
      id: "4",
      date: "2026-11-01T08:30:00.000Z",
      idMemberCreator: "owner-1",
      data: { text: "Reason: priorities changed" },
    },
  ];
  const outcome = record("stopped", comments);
  assert.equal(outcome.recorded, true);
  if (!outcome.recorded) return;
  assert.deepEqual(validator.validate("ClosureRecord", outcome.closure).errors, []);
  assert.equal(outcome.closure?.outcome, "stopped");
  assert.equal(outcome.closure?.reason, "priorities changed");
  assert.deepEqual(outcome.closure?.latest_artifact, packageRef);
});

test("there is nothing to decide without a verified pass under the active freeze", () => {
  const failed = record("approved_for_integration_and_release", evaluationComments("fail"));
  assert.equal(failed.recorded, false);
  assert.match(!failed.recorded ? failed.reason : "", /not a pass/);

  const rejected = record("approved_for_integration_and_release", evaluationComments("pass", "rejected"));
  assert.match(!rejected.recorded ? rejected.reason : "", /no accepted StageResultDecision/);

  const superseded = record("approved_for_integration_and_release", evaluationComments(), card("freeze-2"));
  assert.match(!superseded.recorded ? superseded.reason : "", /no longer active/);

  const none = record("approved_for_integration_and_release", []);
  assert.match(!none.recorded ? none.reason : "", /not a pass/);
});
