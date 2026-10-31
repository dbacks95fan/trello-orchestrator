// ABOUTME: Builds a read-only handoff from accepted stage records for the Evaluator.

export interface GitEvaluationHandoffInput {
  invocation: Record<string, unknown>;
  stageResult: Record<string, unknown>;
  evidencePackage: Record<string, unknown>;
}

export interface GitEvaluationHandoff {
  workItem: Record<string, unknown>;
  repositoryUrl: string;
  branch: string;
  candidateRevision: string;
  branchRevision: string;
  intentPath: string;
  intentRef: Record<string, unknown>;
  contractRef: Record<string, unknown>;
  evidenceRef: Record<string, unknown>;
  packagePath: string;
}

// ABOUTME: Leaves Git writes to stage agents and returns only immutable artifact references.
export async function prepareGitEvaluationHandoff(input: GitEvaluationHandoffInput): Promise<GitEvaluationHandoff> {
  const invocation = input.invocation;
  const stageResult = input.stageResult;
  const evidencePackage = input.evidencePackage;
  const workItem = stageResult.work_item as Record<string, unknown> | undefined;
  const target = invocation.target as Record<string, unknown> | undefined;
  const candidate = stageResult.candidate as Record<string, unknown> | undefined;
  const freeze = invocation.freeze_activation as Record<string, unknown> | undefined;
  const freezeIntent = freeze?.intent as Record<string, unknown> | undefined;
  const outputs = stageResult.output_artifacts as Array<Record<string, unknown>> | undefined;
  const evidenceRef = outputs?.find((artifact) => String(artifact.path).includes("/evidence-package/"));
  const inputs = invocation.input_artifacts as Array<Record<string, unknown>> | undefined;
  const contractRef = inputs?.find((artifact) => String(artifact.path).endsWith("/work-contract.yaml"));
  const repositoryUrl = String(target?.repository ?? "").replace(/\.git$/i, "");
  const intentId = String(workItem?.intent_id ?? "");
  const intentPath = `.agent/work/${intentId}/intent.md`;
  const contract = evidencePackage.input_artifacts as Array<Record<string, unknown>> | undefined;
  if (
    !workItem ||
    !target ||
    !candidate ||
    !freezeIntent ||
    !evidenceRef ||
    !contractRef ||
    !contract?.some((ref) => ref.path === contractRef.path)
  ) {
    throw new Error(
      "Coding Agent output is missing the candidate or immutable artifact references required by Evaluation.",
    );
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(repositoryUrl))
    throw new Error("The candidate repository must be an HTTPS GitHub repository.");
  if (
    candidate.repository !== repositoryUrl ||
    evidenceRef.repository !== repositoryUrl ||
    contractRef.repository !== repositoryUrl
  ) {
    throw new Error("The candidate and Evaluation inputs must reference the same product repository.");
  }
  if (evidenceRef.commit_sha === candidate.commit_sha)
    throw new Error("The Evidence Package must be committed after the immutable candidate.");
  return {
    workItem,
    repositoryUrl,
    branch: String(invocation.workspace_ref ?? ""),
    candidateRevision: String(candidate.commit_sha ?? ""),
    branchRevision: String(evidenceRef.commit_sha ?? ""),
    intentPath,
    intentRef: {
      repository: repositoryUrl,
      commit_sha: candidate.commit_sha,
      path: intentPath,
      sha256: freezeIntent.sha256,
    },
    contractRef,
    evidenceRef,
    packagePath: `.agent/work/${intentId}/evaluation-package/evaluation.json`,
  };
}
