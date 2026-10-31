// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Verifies the Orchestrator submits a StageInvocation to the Coding Agent service and handles every service outcome.
import assert from "node:assert/strict";
import test from "node:test";
import { runCodingAgent, type CodingAgentRunOptions, type FetchRequest } from "./runCodingAgent.js";

const invocation = { invocation_id: "invocation-1", stage: "execution", work_item: { intent_id: "INT-MF-0042" }, target: { repository: "https://github.com/example/mealflow" } };
const stageResult = { schema_version: "1.0", invocation_id: "invocation-1", stage: "execution", status: "candidate_complete" };
const done = { invocation_id: "invocation-1", state: "done", stage_result: stageResult, evidence_package: { schema_version: "1.0" }, diagnostics: { reasons: [] } };
const running = { invocation_id: "invocation-1", state: "running" };

interface Recorded { method: string; url: string; authorization: string | null; body: string }

/** Replays scripted responses in order and records each request. */
function scripted(responses: Array<Response | Error>): { requestFn: FetchRequest; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const requestFn: FetchRequest = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization"), body: await request.text() });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { requestFn, requests };
}

function options(requestFn: FetchRequest, overrides: Partial<CodingAgentRunOptions> = {}): CodingAgentRunOptions {
  return { endpoint: "http://coding-agent.test:8081/", token: "test-token", pollIntervalMs: 10, timeoutMs: 1000, requestFn, sleep: async () => {}, log: () => {}, ...overrides };
}

test("submits the invocation with bearer authentication and polls until the run is done", async () => {
  const { requestFn, requests } = scripted([Response.json(running, { status: 202 }), Response.json(running), Response.json(done)]);
  const result = await runCodingAgent(invocation, options(requestFn));

  assert.equal(result.error, null);
  assert.equal(result.stageResult?.status, "candidate_complete");
  assert.deepEqual(result.evidencePackage, { schema_version: "1.0" });
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
    "POST http://coding-agent.test:8081/invocations",
    "GET http://coding-agent.test:8081/invocations/invocation-1",
    "GET http://coding-agent.test:8081/invocations/invocation-1",
  ]);
  assert.ok(requests.every((request) => request.authorization === "Bearer test-token"));
  assert.deepEqual(JSON.parse(requests[0].body), invocation);
});

test("returns an already finished run without polling", async () => {
  const { requestFn, requests } = scripted([Response.json(done)]);
  const result = await runCodingAgent(invocation, options(requestFn));
  assert.equal(result.stageResult?.invocation_id, "invocation-1");
  assert.equal(requests.length, 1);
});

test("a finished run without a stage result is returned as such for the workflow to reject", async () => {
  const { requestFn } = scripted([Response.json({ ...done, stage_result: null, evidence_package: null })]);
  const result = await runCodingAgent(invocation, options(requestFn));
  assert.equal(result.error, null);
  assert.equal(result.stageResult, null);
  assert.deepEqual(result.diagnostics, { reasons: [] });
});

test("reports a rejected API token", async () => {
  const { requestFn } = scripted([Response.json({ error: "unauthorized" }, { status: 401 })]);
  const result = await runCodingAgent(invocation, options(requestFn));
  assert.equal(result.stageResult, null);
  assert.match(result.error ?? "", /rejected the Orchestrator's API token/);
});

test("reports a busy service instead of retrying the submission", async () => {
  const { requestFn, requests } = scripted([Response.json({ error: "busy", running_invocation_id: "other" }, { status: 409 })]);
  const result = await runCodingAgent(invocation, options(requestFn));
  assert.match(result.error ?? "", /busy/);
  assert.equal(requests.length, 1);
});

test("reports other refusals with their HTTP status", async () => {
  const { requestFn } = scripted([Response.json({ error: "body is not a StageInvocation" }, { status: 400 })]);
  const result = await runCodingAgent(invocation, options(requestFn));
  assert.match(result.error ?? "", /HTTP 400/);
  assert.match(result.rawOutput, /not a StageInvocation/);
});

test("reports an unreachable service", async () => {
  const { requestFn } = scripted([new Error("connect ECONNREFUSED")]);
  const result = await runCodingAgent(invocation, options(requestFn));
  assert.match(result.error ?? "", /could not be reached: connect ECONNREFUSED/);
});

test("reports a non-JSON submission response", async () => {
  const { requestFn } = scripted([new Response("<html>proxy error</html>", { status: 202 })]);
  const result = await runCodingAgent(invocation, options(requestFn));
  assert.match(result.error ?? "", /not JSON/);
});

test("treats an unknown invocation during polling as an unknown outcome", async () => {
  const { requestFn } = scripted([Response.json(running, { status: 202 }), Response.json({ error: "unknown invocation_id" }, { status: 404 })]);
  const result = await runCodingAgent(invocation, options(requestFn));
  assert.match(result.error ?? "", /no longer knows invocation invocation-1/);
});

test("tolerates a transient poll failure and recovers", async () => {
  const messages: string[] = [];
  const { requestFn } = scripted([Response.json(running, { status: 202 }), new Error("socket hang up"), Response.json(done)]);
  const result = await runCodingAgent(invocation, options(requestFn, { log: (message) => messages.push(message) }));
  assert.equal(result.stageResult?.status, "candidate_complete");
  assert.deepEqual(messages, ["Coding Agent status poll 1/3 failed for invocation invocation-1."]);
});

test("gives up after repeated poll failures", async () => {
  const { requestFn, requests } = scripted([Response.json(running, { status: 202 }), new Error("down"), new Response("bad gateway", { status: 502 }), new Error("down")]);
  const result = await runCodingAgent(invocation, options(requestFn));
  assert.match(result.error ?? "", /could not be read 3 times in a row/);
  assert.equal(requests.length, 4);
});

test("stops waiting at the timeout and says the run may still be going", async () => {
  let clock = 0;
  const { requestFn, requests } = scripted([Response.json(running, { status: 202 }), Response.json(running), Response.json(running), Response.json(running)]);
  const result = await runCodingAgent(invocation, options(requestFn, {
    timeoutMs: 25,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  }));
  assert.match(result.error ?? "", /did not finish invocation invocation-1 within 25 ms/);
  assert.equal(requests.length, 4);
});
