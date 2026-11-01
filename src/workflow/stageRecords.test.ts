// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests reading stage runs and decisions back from card comments, newest first.
import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { config } from "../config.js";
import type { TrelloComment } from "../trello/client.js";
import { latestStageRun, machineRecordComment, parseMachineRecord, stageResults } from "./stageRecords.js";

const validator = createLifecycleValidator(config.lifecycleSchemaPath);
const workItem = { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 3, trello_card_id: "card-1" };
const repo = "https://github.com/example/mealflow";
const freeze = {
  schema_version: "1.0",
  event_id: "freeze-1",
  event_type: "activated",
  work_item: workItem,
  intent: { repository: repo, commit_sha: "a".repeat(40), path: "i.md", sha256: "1".repeat(64) },
  policy_profile_id: "P",
  policy_profile_version: "1",
  policy_profile: { repository: repo, commit_sha: "a".repeat(40), path: "p.md", sha256: "2".repeat(64) },
  authorized_by: "owner-1",
  recorded_at: "2026-10-27T11:00:00.000Z",
};

function invocation(id: string) {
  return {
    schema_version: "1.1",
    invocation_id: id,
    trigger_event_id: `evt-${id}`,
    stage: "execution",
    work_item: workItem,
    freeze_activation: freeze,
    input_artifacts: [],
    target: { repository: repo, commit_sha: "b".repeat(40) },
    workspace_ref: "work/INT-MF-0042",
    read_paths: ["."],
    write_paths: ["."],
  };
}

function result(id: string, status: string) {
  return {
    schema_version: "1.0",
    invocation_id: id,
    stage: "execution",
    work_item: workItem,
    status,
    output_artifacts: [],
    summary: "s",
  };
}

function comment(text: string, date: string): TrelloComment {
  return { id: date, date, data: { text } };
}

test("records round-trip through a comment and unrelated text is ignored", () => {
  const text = machineRecordComment("stage-result", result("inv-1", "failed"), "note");
  assert.deepEqual(parseMachineRecord(text, "stage-result"), result("inv-1", "failed"));
  assert.equal(parseMachineRecord(text, "stage-invocation"), null);
  assert.equal(parseMachineRecord("<!-- agentic-sdlc-stage-result {bad json -->", "stage-result"), null);
});

test("the newest valid result wins and is paired with its own invocation", () => {
  const comments = [
    comment(machineRecordComment("stage-invocation", invocation("inv-1"), ""), "2026-11-01T01:00:00Z"),
    comment(machineRecordComment("stage-result", result("inv-1", "failed"), ""), "2026-11-01T01:10:00Z"),
    comment(machineRecordComment("stage-invocation", invocation("inv-2"), ""), "2026-11-01T02:00:00Z"),
    comment(machineRecordComment("stage-result", result("inv-2", "blocked"), ""), "2026-11-01T02:10:00Z"),
    comment(machineRecordComment("stage-result", { ...result("inv-3", "bogus") }, ""), "2026-11-01T03:00:00Z"),
  ];
  const run = latestStageRun(comments, "execution", "card-1", validator);
  assert.equal(run?.result.invocation_id, "inv-2");
  assert.equal(run?.invocation.invocation_id, "inv-2");
  assert.deepEqual(
    stageResults(comments, "execution", "card-1", validator).map((r) => r.invocation_id),
    ["inv-2", "inv-1"],
  );
  assert.equal(latestStageRun(comments, "evaluation", "card-1", validator), null);
  assert.equal(latestStageRun(comments, "execution", "other-card", validator), null);
});

test("a result without its invocation is not a usable run", () => {
  const comments = [
    comment(machineRecordComment("stage-result", result("inv-9", "failed"), ""), "2026-11-01T01:00:00Z"),
  ];
  assert.equal(latestStageRun(comments, "execution", "card-1", validator), null);
});
