// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests Evaluation and rework invocation building, pushed-package verification, and finding-based routing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { config } from "../config.js";
import {
  buildEvaluationInvocation,
  buildReworkInvocation,
  compareRequiredValidation,
  isRework,
  routeEvaluation,
  stageResultDecision,
  verifyPushedPackage,
  workContractRef,
  type PackageReads,
} from "./evaluationStage.js";
import type { StageRun } from "./stageRecords.js";

const validator = createLifecycleValidator(config.lifecycleSchemaPath);
const sha = (c: string) => c.repeat(40);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const repo = "https://github.com/example/mealflow";
const work = ".agent/work/INT-MF-0042";
const workItem = { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 3, trello_card_id: "card-1" };
const freeze = {
  schema_version: "1.0",
  event_id: "freeze-1",
  event_type: "activated",
  work_item: workItem,
  intent: {
    repository: "https://github.com/example/intent-backlog",
    commit_sha: sha("a"),
    path: "i/intent.md",
    sha256: "1".repeat(64),
  },
  policy_profile_id: "MF-DEFAULT",
  policy_profile_version: "1",
  policy_profile: {
    repository: "https://github.com/example/intent-backlog",
    commit_sha: sha("a"),
    path: "p/default.md",
    sha256: "2".repeat(64),
  },
  authorized_by: "owner-1",
  recorded_at: "2026-10-27T11:00:00.000Z",
};
const specRef = { repository: repo, commit_sha: sha("b"), path: `${work}/spec.md`, sha256: "3".repeat(64) };
const contractRef = {
  repository: repo,
  commit_sha: sha("b"),
  path: `${work}/work-contract.yaml`,
  sha256: "4".repeat(64),
};
const evidenceRef = {
  repository: repo,
  commit_sha: sha("d"),
  path: `${work}/evidence-package/inv-x.json`,
  sha256: "5".repeat(64),
};

function executionRun(overrides: Record<string, unknown> = {}): StageRun {
  return {
    invocation: {
      schema_version: "1.1",
      invocation_id: "inv-x",
      trigger_event_id: "evt-x",
      stage: "execution",
      work_item: workItem,
      freeze_activation: freeze,
      input_artifacts: [specRef, contractRef],
      target: { repository: repo, commit_sha: sha("b") },
      workspace_ref: "work/INT-MF-0042",
      read_paths: ["."],
      write_paths: ["."],
    },
    result: {
      schema_version: "1.0",
      invocation_id: "inv-x",
      stage: "execution",
      work_item: workItem,
      status: "candidate_complete",
      output_artifacts: [evidenceRef],
      candidate: { repository: repo, commit_sha: sha("c") },
      summary: "Candidate complete.",
      ...overrides,
    },
  };
}

test("an Evaluation invocation carries the accepted inputs plus the evidence, targeting the evidence commit", () => {
  const invocation = buildEvaluationInvocation(executionRun(), "evt-eval", "inv-eval");
  assert.deepEqual(validator.validate("StageInvocation", invocation).errors, []);
  assert.equal(invocation.stage, "evaluation");
  assert.deepEqual(invocation.input_artifacts, [specRef, contractRef, evidenceRef]);
  assert.deepEqual(invocation.target, { repository: repo, commit_sha: sha("d") });
  assert.deepEqual(invocation.write_paths, [`${work}/evaluation-package`]);
  assert.equal(invocation.freeze_activation, freeze);
});

test("only a candidate_complete Execution result can be evaluated", () => {
  assert.throws(
    () => buildEvaluationInvocation(executionRun({ status: "failed", output_artifacts: [] }), "evt"),
    /Only a candidate_complete/,
  );
});

test("a rework invocation adds the failing Evaluation Package and targets its commit", () => {
  const packageRef = {
    repository: repo,
    commit_sha: sha("e"),
    path: `${work}/evaluation-package/inv-eval.json`,
    sha256: "6".repeat(64),
  };
  const evaluation: StageRun = {
    invocation: buildEvaluationInvocation(executionRun(), "evt-eval", "inv-eval"),
    result: { stage: "evaluation", invocation_id: "inv-eval", status: "fail", output_artifacts: [packageRef] },
  };
  const rework = buildReworkInvocation(executionRun(), evaluation, "evt-rework", "inv-rework");
  assert.deepEqual(validator.validate("StageInvocation", rework).errors, []);
  assert.equal(rework.stage, "execution");
  assert.deepEqual(rework.input_artifacts, [specRef, contractRef, packageRef]);
  assert.deepEqual(rework.target, { repository: repo, commit_sha: sha("e") });
  assert.equal(isRework(rework), true);
  assert.equal(isRework(executionRun().invocation), false);

  // A second rework drops the earlier package and carries only the newest one.
  const second = buildReworkInvocation({ invocation: rework, result: executionRun().result }, evaluation, "evt-2");
  assert.equal((second.input_artifacts as unknown[]).length, 3);
  assert.deepEqual(workContractRef(second), contractRef);
});

test("required validation must be present and passed", () => {
  const required = [{ name: "build" }, { name: "playwright" }];
  assert.deepEqual(
    compareRequiredValidation(
      required,
      [
        { name: "build", outcome: "passed" },
        { name: "playwright", outcome: "passed" },
      ],
      "X",
    ),
    [],
  );
  assert.deepEqual(compareRequiredValidation(required, [{ name: "build", outcome: "failed" }], "X"), [
    "X records required check build as failed.",
    "X has no outcome for required check playwright.",
  ]);
});

test("routing follows the finding categories", () => {
  const blocking = (category: string) => [{ category, severity: "blocking", summary: "x" }];
  assert.equal(routeEvaluation("pass", []), "human_approval");
  assert.equal(routeEvaluation("fail", blocking("implementation")), "execution_rework");
  assert.equal(routeEvaluation("fail", blocking("evidence")), "execution_rework");
  assert.equal(
    routeEvaluation("fail", [...blocking("implementation"), ...blocking("specification")]),
    "hold_specification",
  );
  assert.equal(routeEvaluation("fail", blocking("policy")), "hold_policy");
  assert.equal(
    routeEvaluation("fail", [{ category: "implementation", severity: "non_blocking", summary: "x" }]),
    "hold",
  );
  assert.equal(routeEvaluation("needs_decision", []), "hold");
  assert.equal(routeEvaluation("blocked", []), "hold");
});

function reads(files: Record<string, string>, tip: string, parents: Record<string, string[]>): PackageReads {
  return {
    branchTip: async () => tip,
    fileAt: async (_commit, path) => {
      if (!(path in files)) throw new Error(`missing ${path}`);
      return Buffer.from(files[path]);
    },
    parentsOf: async (commit) => parents[commit] ?? [],
  };
}

const evidencePackage = {
  schema_version: "1.0",
  work_item: workItem,
  input_artifacts: [specRef, contractRef],
  candidate: { repository: repo, commit_sha: sha("c") },
  changed_paths: ["client/src/App.tsx"],
  validation: [{ name: "build", outcome: "passed", observed_at: "2026-10-31T10:00:00Z", summary: "exit 0" }],
  policy_control_evidence: [],
  status: "candidate_complete",
  summary: "done",
};

test("a pushed Evidence Package must be the tip, on its candidate, on the handoff, and hash and validate", async () => {
  const text = `${JSON.stringify(evidencePackage)}\n`;
  const ref = { ...evidenceRef, sha256: hash(text) };
  const good = await verifyPushedPackage({
    ref,
    branch: "work/INT-MF-0042",
    handoff: sha("b"),
    definition: "EvidencePackage",
    reads: reads({ [ref.path]: text }, sha("d"), { [sha("d")]: [sha("c")], [sha("c")]: [sha("b")] }),
    validator,
  });
  assert.deepEqual(good.issues, []);
  assert.equal(good.pkg?.status, "candidate_complete");

  const moved = await verifyPushedPackage({
    ref,
    branch: "work/INT-MF-0042",
    handoff: sha("b"),
    definition: "EvidencePackage",
    reads: reads({ [ref.path]: text }, sha("f"), { [sha("d")]: [sha("c")], [sha("c")]: [sha("9")] }),
    validator,
  });
  assert.match(moved.issues.join(" "), /work branch is at f+, not the EvidencePackage commit/);
  assert.match(moved.issues.join(" "), /candidate c+ is not directly on the handoff/);

  const tampered = await verifyPushedPackage({
    ref,
    branch: "work/INT-MF-0042",
    handoff: sha("b"),
    definition: "EvidencePackage",
    reads: reads({ [ref.path]: text.replace("done", "edited") }, sha("d"), {}),
    validator,
  });
  assert.match(tampered.issues.join(" "), /does not match its reported SHA-256/);
});

test("a pushed Evaluation Package must sit directly on the handoff and validate", async () => {
  const pkg = {
    schema_version: "1.0",
    work_item: workItem,
    input_artifacts: [specRef, contractRef, evidenceRef],
    candidate: { repository: repo, commit_sha: sha("c") },
    checks: [{ name: "build", outcome: "passed", observed_at: "2026-10-31T11:00:00Z", summary: "exit 0" }],
    findings: [],
    status: "pass",
    summary: "ok",
  };
  const text = `${JSON.stringify(pkg)}\n`;
  const ref = {
    repository: repo,
    commit_sha: sha("e"),
    path: `${work}/evaluation-package/inv-eval.json`,
    sha256: hash(text),
  };
  const ok = await verifyPushedPackage({
    ref,
    branch: "work/INT-MF-0042",
    handoff: sha("d"),
    definition: "EvaluationPackage",
    reads: reads({ [ref.path]: text }, sha("e"), { [sha("e")]: [sha("d")] }),
    validator,
  });
  assert.deepEqual(ok.issues, []);
  const invalid = `${JSON.stringify({ ...pkg, status: "pass", checks: [] })}\n`;
  const bad = await verifyPushedPackage({
    ref: { ...ref, sha256: hash(invalid) },
    branch: "work/INT-MF-0042",
    handoff: sha("d"),
    definition: "EvaluationPackage",
    reads: reads({ [ref.path]: invalid }, sha("e"), { [sha("e")]: [sha("0")] }),
    validator,
  });
  assert.match(bad.issues.join(" "), /not directly on the handoff/);
  assert.match(bad.issues.join(" "), /EvaluationPackage is invalid/);
});

test("a StageResultDecision validates, and a rejection carries its reason", () => {
  const run = executionRun();
  const accepted = stageResultDecision({
    run,
    result: evidenceRef,
    disposition: "accepted",
    recordedAt: "2026-11-01T01:00:00.000Z",
  });
  assert.deepEqual(validator.validate("StageResultDecision", accepted).errors, []);
  const rejected = stageResultDecision({
    run,
    result: evidenceRef,
    disposition: "rejected",
    recordedAt: "2026-11-01T01:00:00.000Z",
    reason: "superseded",
  });
  assert.deepEqual(validator.validate("StageResultDecision", rejected).errors, []);
  assert.equal(validator.validate("StageResultDecision", { ...rejected, reason: undefined }).valid, false);
});
