// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Submits an Execution StageInvocation to the Coding Agent service over HTTP and polls for its result.

export interface CodingAgentResult {
  stageResult: Record<string, unknown> | null;
  evidencePackage: Record<string, unknown> | null;
  diagnostics: Record<string, unknown> | null;
  /** Why no result could be obtained; null when the service returned a finished run. */
  error: string | null;
  rawOutput: string;
}

export type FetchRequest = typeof fetch;

export interface CodingAgentRunOptions {
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
  diagnostics?: unknown;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function failure(error: string, rawOutput = ""): CodingAgentResult {
  return { stageResult: null, evidencePackage: null, diagnostics: null, error, rawOutput };
}

function finished(view: ServiceView, rawOutput: string): CodingAgentResult {
  return {
    stageResult: object(view.stage_result),
    evidencePackage: object(view.evidence_package),
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

/** Runs one invocation on the Coding Agent service. Never throws; every problem is returned as `error`. */
export async function runCodingAgent(invocation: Record<string, unknown>, options: CodingAgentRunOptions): Promise<CodingAgentResult> {
  const requestFn = options.requestFn ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(`[trello-orchestrator] ${message}`));
  const maxPollFailures = options.maxPollFailures ?? 3;
  const base = options.endpoint.replace(/\/$/, "");
  const invocationId = String(invocation.invocation_id ?? "");
  const headers = { Authorization: `Bearer ${options.token}` };

  let body: string;
  let status: number;
  try {
    const response = await requestFn(`${base}/invocations`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(invocation),
    });
    status = response.status;
    body = await response.text();
  } catch (err) {
    return failure(`The Coding Agent service at ${base} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (status === 401) return failure("The Coding Agent service rejected the Orchestrator's API token (HTTP 401).", body);
  if (status === 409) return failure("The Coding Agent service is busy with another run or already holds different content for this invocation ID (HTTP 409).", body);
  if (status !== 200 && status !== 202) return failure(`The Coding Agent service refused the invocation with HTTP ${status}.`, body);
  let view = parseView(body);
  if (!view) return failure("The Coding Agent service returned a response that is not JSON.", body);

  const deadline = now() + options.timeoutMs;
  let pollFailures = 0;
  while (view.state !== "done") {
    if (now() >= deadline) {
      return failure(`The Coding Agent did not finish invocation ${invocationId} within ${options.timeoutMs} ms. It may still be running; check the service before acting.`, body);
    }
    await sleep(options.pollIntervalMs);
    let polled: ServiceView | null = null;
    try {
      const response = await requestFn(`${base}/invocations/${encodeURIComponent(invocationId)}`, { headers });
      body = await response.text();
      if (response.status === 404) {
        return failure(`The Coding Agent service no longer knows invocation ${invocationId}; it may have restarted. The outcome is unknown and needs human triage.`, body);
      }
      if (response.ok) polled = parseView(body);
    } catch (err) {
      body = err instanceof Error ? err.message : String(err);
    }
    if (!polled) {
      pollFailures += 1;
      log(`Coding Agent status poll ${pollFailures}/${maxPollFailures} failed for invocation ${invocationId}.`);
      if (pollFailures >= maxPollFailures) {
        return failure(`The Coding Agent status could not be read ${maxPollFailures} times in a row for invocation ${invocationId}. The outcome is unknown and needs human triage.`, body);
      }
      continue;
    }
    pollFailures = 0;
    view = polled;
  }
  return finished(view, body);
}
