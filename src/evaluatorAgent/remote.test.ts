// ABOUTME: Defines unit tests for the immutable Git handoff sent to the remote evaluator.
import assert from "node:assert/strict";
import test from "node:test";
import { runRemoteEvaluator } from "./remote.js";

test("sends immutable artifact refs and bytes with bearer authentication", async () => {
  let request: Request | undefined;
  const workItem = { product_id: "mealflow", intent_id: "INT-1", intent_version: 1, trello_card_id: "card-1" };
  const ref = {
    repository: "https://github.com/example/candidate",
    commit_sha: "a".repeat(40),
    path: ".agent/work/INT-1/intent.md",
    sha256: "c".repeat(64),
  };
  const evaluationPackage = {
    repositoryUrl: "https://github.com/example/candidate",
    branch: "work/INT-1",
    candidateRevision: "a".repeat(40),
    packageRevision: "b".repeat(40),
    path: ".agent/work/INT-1/evaluation-package/evaluation.json",
    sha256: "c".repeat(64),
  };
  const result = await runRemoteEvaluator(
    {
      endpoint: "http://evaluator.test/evaluations",
      token: "test-token",
      repositoryUrl: "https://github.com/example/candidate",
      branch: "work/INT-1",
      revision: "a".repeat(40),
      branchRevision: "b".repeat(40),
      workItem,
      intentRef: ref,
      contractRef: { ...ref, path: ".agent/work/INT-1/work-contract.yaml" },
      evidenceRef: { ...ref, commit_sha: "b".repeat(40), path: ".agent/work/INT-1/evidence-package/evidence.json" },
      intentText: "intent bytes",
      contractText: "contract bytes",
      evidenceText: "evidence bytes",
      packagePath: evaluationPackage.path,
    },
    async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ evaluation: { status: "pass", summary: "Verified" }, evaluationPackage }), {
        status: 200,
      });
    },
  );

  assert.equal(request?.headers.get("authorization"), "Bearer test-token");
  assert.deepEqual(JSON.parse(await request!.text()), {
    repositoryUrl: "https://github.com/example/candidate",
    branch: "work/INT-1",
    revision: "a".repeat(40),
    branchRevision: "b".repeat(40),
    workItem,
    intentRef: ref,
    contractRef: { ...ref, path: ".agent/work/INT-1/work-contract.yaml" },
    evidenceRef: { ...ref, commit_sha: "b".repeat(40), path: ".agent/work/INT-1/evidence-package/evidence.json" },
    intentText: "intent bytes",
    contractText: "contract bytes",
    evidenceText: "evidence bytes",
    packagePath: evaluationPackage.path,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.evaluation?.status, "pass");
  assert.equal(result.evaluationPackage?.packageRevision, "b".repeat(40));
});
