// ABOUTME: Verifies the remote evaluator handoff across a real local HTTP boundary.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runRemoteEvaluator } from "./remote.js";

test("sends an authenticated Git revision handoff to an evaluator HTTP endpoint", async () => {
  let authorization = "";
  let body = "";
  const evaluationPackage = {
    repositoryUrl: "https://github.com/example/candidate",
    branch: "work/INT-2",
    candidateRevision: "b".repeat(40),
    packageRevision: "c".repeat(40),
    path: ".agent/work/INT-2/evaluation-package/evaluation.json",
    sha256: "d".repeat(64),
  };
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization ?? "";
    for await (const chunk of request) body += String(chunk);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        evaluation: { status: "pass", summary: "Remote evaluator completed the Git revision." },
        evaluationPackage,
      }),
    );
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not provide a TCP address");
  try {
    const result = await runRemoteEvaluator({
      endpoint: `http://127.0.0.1:${address.port}/evaluations`,
      token: "integration-token",
      repositoryUrl: "https://github.com/example/candidate",
      branch: "work/INT-2",
      revision: "b".repeat(40),
      branchRevision: "c".repeat(40),
      workItem: { product_id: "mealflow", intent_id: "INT-2", intent_version: 1, trello_card_id: "card-2" },
      intentRef: {
        repository: "https://github.com/example/candidate",
        commit_sha: "b".repeat(40),
        path: ".agent/work/INT-2/intent.md",
        sha256: "d".repeat(64),
      },
      contractRef: {
        repository: "https://github.com/example/candidate",
        commit_sha: "b".repeat(40),
        path: ".agent/work/INT-2/work-contract.yaml",
        sha256: "e".repeat(64),
      },
      evidenceRef: {
        repository: "https://github.com/example/candidate",
        commit_sha: "c".repeat(40),
        path: ".agent/work/INT-2/evidence-package/evidence.json",
        sha256: "f".repeat(64),
      },
      intentText: "intent bytes",
      contractText: "contract bytes",
      evidenceText: "evidence bytes",
      packagePath: evaluationPackage.path,
    });
    assert.equal(authorization, "Bearer integration-token");
    assert.equal(JSON.parse(body).revision, "b".repeat(40));
    assert.equal(JSON.parse(body).branchRevision, "c".repeat(40));
    assert.equal(result.evaluation?.status, "pass");
    assert.equal(result.evaluationPackage?.packageRevision, "c".repeat(40));
  } finally {
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }
});
