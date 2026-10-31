// ABOUTME: Sends pinned artifact bytes and Git references to the authenticated Evaluator service.
export interface RemoteEvaluatorRequest {
  endpoint: string;
  token: string;
  repositoryUrl: string;
  branch: string;
  revision: string;
  branchRevision: string;
  workItem: Record<string, unknown>;
  intentRef: Record<string, unknown>;
  contractRef: Record<string, unknown>;
  evidenceRef: Record<string, unknown>;
  contractText: string;
  evidenceText: string;
  intentText: string;
  packagePath: string;
}

export interface RemoteEvaluatorResult {
  exitCode: number;
  evaluation: Record<string, unknown> | null;
  evaluationPackage: {
    repositoryUrl: string;
    branch: string;
    candidateRevision: string;
    packageRevision: string;
    path: string;
    sha256: string;
  } | null;
  rawOutput: string;
}

export type FetchRequest = typeof fetch;

// ABOUTME: Preserves the evaluator result shape used by Trello workflow handling.
export async function runRemoteEvaluator(
  request: RemoteEvaluatorRequest,
  requestFn: FetchRequest = fetch,
): Promise<RemoteEvaluatorResult> {
  const response = await requestFn(
    new Request(request.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositoryUrl: request.repositoryUrl,
        branch: request.branch,
        revision: request.revision,
        branchRevision: request.branchRevision,
        workItem: request.workItem,
        intentRef: request.intentRef,
        contractRef: request.contractRef,
        evidenceRef: request.evidenceRef,
        contractText: request.contractText,
        evidenceText: request.evidenceText,
        intentText: request.intentText,
        packagePath: request.packagePath,
      }),
    }),
  );
  const body = await response.text();
  if (!response.ok)
    throw new Error(`Remote evaluator request failed with HTTP ${response.status}: ${body.slice(0, 500)}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { exitCode: 1, evaluation: null, evaluationPackage: null, rawOutput: body };
  }
  const envelope =
    typeof parsed === "string" ? (JSON.parse(parsed) as Record<string, unknown>) : (parsed as Record<string, unknown>);
  const evaluation =
    envelope.evaluation && typeof envelope.evaluation === "object"
      ? (envelope.evaluation as Record<string, unknown>)
      : null;
  const rawPackage =
    envelope.evaluationPackage && typeof envelope.evaluationPackage === "object"
      ? (envelope.evaluationPackage as Record<string, unknown>)
      : null;
  const evaluationPackage =
    rawPackage &&
    typeof rawPackage.repositoryUrl === "string" &&
    typeof rawPackage.branch === "string" &&
    typeof rawPackage.candidateRevision === "string" &&
    typeof rawPackage.packageRevision === "string" &&
    typeof rawPackage.path === "string" &&
    typeof rawPackage.sha256 === "string"
      ? (rawPackage as RemoteEvaluatorResult["evaluationPackage"])
      : null;
  return { exitCode: evaluation && evaluationPackage ? 0 : 1, evaluation, evaluationPackage, rawOutput: body };
}
