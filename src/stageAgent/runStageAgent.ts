// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Submits a StageInvocation to a stage worker service (Coding Agent or Evaluator) over HTTP and polls for its result.
// ABOUTME: Workers and the deploy service share one boundary: POST a request, then GET it by ID until done.

export interface StageAgentResult {
  stageResult: Record<string, unknown> | null;
  evidencePackage: Record<string, unknown> | null;
  evaluationPackage: Record<string, unknown> | null;
  diagnostics: Record<string, unknown> | null;
  /** Why no result could be obtained; null when the service returned a finished run. */
  error: string | null;
  rawOutput: string;
}

export type FetchRequest = typeof fetch;

export interface StageAgentRunOptions {
  /** Used in every message, e.g. "Coding Agent" or "Evaluator". */
  serviceName: string;
  endpoint: string;
  token: string;
  pollIntervalMs: number;
  timeoutMs: number;
  /** Consecutive failed status polls tolerated before giving up. A poll is a read, so repeating it is safe. */
  maxPollFailures?: number;
  requestFn?: FetchRequest;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

interface ServiceView {
  state?: unknown;
  stage_result?: unknown;
  evidence_package?: unknown;
  evaluation_package?: unknown;
  diagnostics?: unknown;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failure(error: string, rawOutput = ""): StageAgentResult {
  return { stageResult: null, evidencePackage: null, evaluationPackage: null, diagnostics: null, error, rawOutput };
}

function finished(view: ServiceView, rawOutput: string): StageAgentResult {
  return {
    stageResult: object(view.stage_result),
    evidencePackage: object(view.evidence_package),
    evaluationPackage: object(view.evaluation_package),
    diagnostics: object(view.diagnostics),
    error: null,
    rawOutput,
  };
}

function parseView(body: string): ServiceView | null {
  try {
    return object(JSON.parse(body)) as ServiceView | null;
  } catch {
    return null;
  }
}

/** What a service's POST and GET are about: its collection path and the word used for one item in messages. */
export interface ServiceSubmission {
  collection: "invocations" | "deployments";
  noun: "invocation" | "deployment";
  id: string;
  body: Record<string, unknown>;
}

export type ServicePoll =
  { view: Record<string, unknown>; error: null; rawOutput: string } | { view: null; error: string; rawOutput: string };

/**
 * Submits one item to a NAS worker service and polls until it is done. Both stage workers and the deploy
 * service share this boundary: POST /<collection>, then GET /<collection>/{id}. Never throws.
 */
export async function submitAndPoll(
  submission: ServiceSubmission,
  options: StageAgentRunOptions,
): Promise<ServicePoll> {
  const name = options.serviceName;
  const { noun, id } = submission;
  const requestFn = options.requestFn ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(`[trello-orchestrator] ${message}`));
  const maxPollFailures = options.maxPollFailures ?? 3;
  const base = options.endpoint.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${options.token}` };
  const fail = (error: string, rawOutput = ""): ServicePoll => ({ view: null, error, rawOutput });

  let body: string;
  let status: number;
  try {
    const response = await requestFn(`${base}/${submission.collection}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(submission.body),
    });
    status = response.status;
    body = await response.text();
  } catch (err) {
    return fail(
      `The ${name} service at ${base} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (status === 401) return fail(`The ${name} service rejected the Orchestrator's API token (HTTP 401).`, body);
  if (status === 409)
    return fail(
      `The ${name} service is busy with another run or already holds different content for this ${noun} ID (HTTP 409).`,
      body,
    );
  if (status !== 200 && status !== 202)
    return fail(`The ${name} service refused the ${noun} with HTTP ${status}.`, body);
  let view = parseView(body);
  if (!view) return fail(`The ${name} service returned a response that is not JSON.`, body);

  const deadline = now() + options.timeoutMs;
  let pollFailures = 0;
  while (view.state !== "done") {
    if (now() >= deadline) {
      return fail(
        `The ${name} did not finish ${noun} ${id} within ${options.timeoutMs} ms. It may still be running; check the service before acting.`,
        body,
      );
    }
    await sleep(options.pollIntervalMs);
    let polled: ServiceView | null = null;
    try {
      const response = await requestFn(`${base}/${submission.collection}/${encodeURIComponent(id)}`, { headers });
      body = await response.text();
      if (response.status === 404) {
        return fail(
          `The ${name} service no longer knows ${noun} ${id}; it may have restarted. The outcome is unknown and needs human triage.`,
          body,
        );
      }
      if (response.ok) polled = parseView(body);
    } catch (err) {
      body = err instanceof Error ? err.message : String(err);
    }
    if (!polled) {
      pollFailures += 1;
      log(`${name} status poll ${pollFailures}/${maxPollFailures} failed for ${noun} ${id}.`);
      if (pollFailures >= maxPollFailures) {
        return fail(
          `The ${name} status could not be read ${maxPollFailures} times in a row for ${noun} ${id}. The outcome is unknown and needs human triage.`,
          body,
        );
      }
      continue;
    }
    pollFailures = 0;
    view = polled;
  }
  return { view: view as Record<string, unknown>, error: null, rawOutput: body };
}

/** Runs one invocation on a stage worker service. Never throws; every problem is returned as `error`. */
export async function runStageAgent(
  invocation: Record<string, unknown>,
  options: StageAgentRunOptions,
): Promise<StageAgentResult> {
  const polled = await submitAndPoll(
    { collection: "invocations", noun: "invocation", id: String(invocation.invocation_id ?? ""), body: invocation },
    options,
  );
  return polled.view ? finished(polled.view as ServiceView, polled.rawOutput) : failure(polled.error, polled.rawOutput);
}
