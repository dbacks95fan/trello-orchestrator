// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests the deploy service call against a real local HTTP server: the report, every refusal, and a slow answer.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { requestDeployment } from "./deployService.js";

const TOKEN = "deploy-test-token";

async function withServer(
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
  body: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    req.on("end", () => handler(req, text, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function answer(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

test("posts the request with the bearer token and returns the report", async () => {
  const seen: { method?: string; url?: string; auth?: string; body?: unknown }[] = [];
  await withServer(
    (req, body, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      answer(res, 200, { deployment_id: "deploy-c1", status: "released" });
    },
    async (endpoint) => {
      const outcome = await requestDeployment(
        { deployment_id: "deploy-c1" },
        { endpoint, token: TOKEN, timeoutMs: 5_000 },
      );
      assert.deepEqual(outcome, { report: { deployment_id: "deploy-c1", status: "released" }, error: null });
    },
  );
  assert.deepEqual(seen, [
    { method: "POST", url: "/deployments", auth: `Bearer ${TOKEN}`, body: { deployment_id: "deploy-c1" } },
  ]);
});

test("refusals, a busy service, and a non-report answer are errors, not reports", async () => {
  for (const [status, body, expected] of [
    [401, { error: "unauthorized" }, /rejected the Orchestrator's API token \(HTTP 401\)/],
    [409, { error: "busy" }, /busy with another deployment \(HTTP 409\)/],
    [500, { error: "internal error" }, /refused the deployment with HTTP 500/],
    [200, "not json", /not a deployment report/],
    [200, { deployment_id: "x" }, /not a deployment report/],
  ] as const) {
    await withServer(
      (_req, _body, res) => answer(res, status, body),
      async (endpoint) => {
        const outcome = await requestDeployment({}, { endpoint, token: TOKEN, timeoutMs: 5_000 });
        assert.equal(outcome.report, null);
        assert.match(outcome.error ?? "", expected);
      },
    );
  }
});

test("waits for a slow deployment, and gives up at the deadline with an unknown outcome", async () => {
  await withServer(
    (_req, _body, res) => setTimeout(() => answer(res, 200, { status: "released" }), 300),
    async (endpoint) => {
      const slow = await requestDeployment({}, { endpoint, token: TOKEN, timeoutMs: 5_000 });
      assert.deepEqual(slow.report, { status: "released" });
      const late = await requestDeployment({}, { endpoint, token: TOKEN, timeoutMs: 100 });
      assert.equal(late.report, null);
      assert.match(late.error ?? "", /no answer within 100 ms; it may still be running/);
    },
  );
});

test("an unreachable service or a bad URL is an error", async () => {
  const down = await requestDeployment({}, { endpoint: "http://127.0.0.1:1", token: TOKEN, timeoutMs: 5_000 });
  assert.match(down.error ?? "", /could not be reached/);
  assert.match(
    (await requestDeployment({}, { endpoint: "not a url", token: TOKEN, timeoutMs: 5_000 })).error ?? "",
    /is not a URL/,
  );
  assert.match(
    (await requestDeployment({}, { endpoint: "ftp://nas", token: TOKEN, timeoutMs: 5_000 })).error ?? "",
    /must be http or https/,
  );
});
