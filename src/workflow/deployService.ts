// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Calls the NAS deploy service: one POST runs one deployment and answers with its report when it finishes.
// ABOUTME: Uses node:http rather than fetch, whose built-in five-minute header and body timeouts a build can exceed.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { DeploymentOutcome } from "./releaseStage.js";

export interface DeployServiceOptions {
  endpoint: string;
  token: string;
  /** How long to wait for the answer before treating the outcome as unknown. */
  timeoutMs: number;
}

function outcomeOf(status: number, text: string): DeploymentOutcome {
  const failure = (error: string): DeploymentOutcome => ({ report: null, error });
  if (status === 401) return failure("the deploy service rejected the Orchestrator's API token (HTTP 401)");
  if (status === 409) return failure("the deploy service is busy with another deployment (HTTP 409)");
  if (status !== 200) return failure(`the deploy service refused the deployment with HTTP ${status}`);
  try {
    const report = JSON.parse(text) as unknown;
    if (
      report &&
      typeof report === "object" &&
      !Array.isArray(report) &&
      typeof (report as { status?: unknown }).status === "string"
    ) {
      return { report: report as Record<string, unknown>, error: null };
    }
  } catch {
    // Reported below as an answer that is not a report.
  }
  return failure("the deploy service answered with something that is not a deployment report");
}

/** Submits one deployment and waits for its report. Never throws; every problem is returned as `error`. */
export function requestDeployment(
  body: Record<string, unknown>,
  options: DeployServiceOptions,
): Promise<DeploymentOutcome> {
  const base = options.endpoint.replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(`${base}/deployments`);
  } catch {
    return Promise.resolve({ report: null, error: `DEPLOY_SERVICE_API_URL ${base} is not a URL` });
  }
  const send = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : null;
  if (!send) return Promise.resolve({ report: null, error: `DEPLOY_SERVICE_API_URL must be http or https` });
  const payload = JSON.stringify(body);

  return new Promise((resolvePromise) => {
    const req = send(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolvePromise(outcomeOf(res.statusCode ?? 0, text)));
        res.on("error", (err) =>
          resolvePromise({ report: null, error: `the deploy service stopped answering: ${err.message}` }),
        );
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error(`no answer within ${options.timeoutMs} ms; it may still be running`)),
      options.timeoutMs,
    );
    req.on("error", (err) =>
      resolvePromise({
        report: null,
        error: `the deploy service at ${base} could not be reached or stopped answering: ${err.message}`,
      }),
    );
    req.on("close", () => clearTimeout(timer));
    req.end(payload);
  });
}
