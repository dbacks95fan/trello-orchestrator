// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Builds Evaluation and rework StageInvocations from recorded stage runs, verifies worker packages read-only
// ABOUTME: against GitHub, compares checks to the accepted contract, and routes an Evaluation result by finding category.
import { createHash, randomUUID } from "node:crypto";
import type { LifecycleValidator } from "../contracts/lifecycle.js";
import type { StageRun } from "./stageRecords.js";

type Record_ = Record<string, unknown>;

function workDir(invocation: Record_): string {
  return `.agent/work/${String((invocation.work_item as Record_).intent_id)}`;
}

function outputRef(result: Record_): Record_ {
  const outputs = result.output_artifacts as Record_[] | undefined;
  if (!outputs?.length) throw new Error(`The ${String(result.stage)} result has no output artifact.`);
  return outputs[0];
}

/** The accepted spec and Work Contract references an Execution invocation carried, without any rework input. */
function acceptedInputs(execution: Record_): Record_[] {
  const work = workDir(execution);
  const inputs = (execution.input_artifacts as Record_[]).filter(
    (ref) => ref.path === `${work}/spec.md` || ref.path === `${work}/work-contract.yaml`,
  );
  if (inputs.length !== 2)
    throw new Error("The Execution invocation does not carry the accepted spec and Work Contract.");
  return inputs;
}

export function workContractRef(execution: Record_): Record_ {
  return acceptedInputs(execution).find((ref) => String(ref.path).endsWith("/work-contract.yaml"))!;
}

/** Evaluation of the candidate an Execution run produced. The handoff is the Evidence Package commit. */
export function buildEvaluationInvocation(
  execution: StageRun,
  triggerEventId: string,
  invocationId: string = randomUUID(),
): Record_ {
  if (execution.result.status !== "candidate_complete") {
    throw new Error(
      `Only a candidate_complete Execution result can be evaluated, not "${String(execution.result.status)}".`,
    );
  }
  const evidence = outputRef(execution.result);
  const target = execution.invocation.target as Record_;
  return {
    schema_version: "1.1",
    invocation_id: invocationId,
    trigger_event_id: triggerEventId,
    stage: "evaluation",
    work_item: execution.invocation.work_item,
    freeze_activation: execution.invocation.freeze_activation,
    input_artifacts: [...acceptedInputs(execution.invocation), evidence],
    target: { repository: target.repository, commit_sha: evidence.commit_sha },
    workspace_ref: execution.invocation.workspace_ref,
    read_paths: ["."],
    write_paths: [`${workDir(execution.invocation)}/evaluation-package`],
  };
}

/** Rework of the last Execution run, with the failing Evaluation Package as bounded findings. */
export function buildReworkInvocation(
  execution: StageRun,
  evaluation: StageRun,
  triggerEventId: string,
  invocationId: string = randomUUID(),
): Record_ {
  const evaluationPackage = outputRef(evaluation.result);
  const target = execution.invocation.target as Record_;
  return {
    schema_version: "1.1",
    invocation_id: invocationId,
    trigger_event_id: triggerEventId,
    stage: "execution",
    work_item: execution.invocation.work_item,
    freeze_activation: execution.invocation.freeze_activation,
    input_artifacts: [...acceptedInputs(execution.invocation), evaluationPackage],
    target: { repository: target.repository, commit_sha: evaluationPackage.commit_sha },
    workspace_ref: execution.invocation.workspace_ref,
    read_paths: execution.invocation.read_paths,
    write_paths: execution.invocation.write_paths,
  };
}

/** True when an Execution invocation is a rework, i.e. it carries an Evaluation Package. */
export function isRework(invocation: Record_): boolean {
  const work = workDir(invocation);
  return (invocation.input_artifacts as Record_[]).some((ref) =>
    String(ref.path).startsWith(`${work}/evaluation-package/`),
  );
}

/** Every required check must be present with outcome `passed`; anything else is an issue. */
export function compareRequiredValidation(
  required: { name: string }[],
  results: { name?: unknown; outcome?: unknown }[],
  label: string,
): string[] {
  const issues: string[] = [];
  for (const check of required) {
    const result = results.find((entry) => entry.name === check.name);
    if (!result) issues.push(`${label} has no outcome for required check ${check.name}.`);
    else if (result.outcome !== "passed")
      issues.push(`${label} records required check ${check.name} as ${String(result.outcome)}.`);
  }
  return issues;
}

export interface PackageReads {
  branchTip(branch: string): Promise<string>;
  fileAt(commit: string, path: string): Promise<Buffer>;
  parentsOf(commit: string): Promise<string[]>;
}

/**
 * Read-only checks a worker's pushed package must pass before its result is routed: the
 * branch tip is the package commit, its only parent is the handoff, and the bytes hash and
 * validate. Returns the parsed package and every issue found.
 */
export async function verifyPushedPackage(args: {
  ref: Record_;
  branch: string;
  handoff: string;
  definition: "EvidencePackage" | "EvaluationPackage";
  reads: PackageReads;
  validator: LifecycleValidator;
}): Promise<{ pkg: Record_ | null; issues: string[] }> {
  const { ref, reads } = args;
  const commit = String(ref.commit_sha);
  const issues: string[] = [];
  const tip = await reads.branchTip(args.branch);
  if (tip !== commit) issues.push(`The work branch is at ${tip}, not the ${args.definition} commit ${commit}.`);
  const parents = await reads.parentsOf(commit);
  if (args.definition === "EvaluationPackage" && (parents.length !== 1 || parents[0] !== args.handoff)) {
    issues.push(`The Evaluation Package commit is not directly on the handoff ${args.handoff}.`);
  }
  const bytes = await reads.fileAt(commit, String(ref.path));
  if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) {
    issues.push(`${String(ref.path)} does not match its reported SHA-256.`);
    return { pkg: null, issues };
  }
  let pkg: Record_;
  try {
    pkg = JSON.parse(bytes.toString("utf8")) as Record_;
  } catch {
    issues.push(`${String(ref.path)} is not valid JSON.`);
    return { pkg: null, issues };
  }
  const validation = args.validator.validate(args.definition, pkg);
  if (!validation.valid) {
    issues.push(`The ${args.definition} is invalid: ${validation.errors.join("; ")}`);
    return { pkg, issues };
  }
  if (args.definition === "EvidencePackage") {
    // The Coding Agent's history is linear: handoff -> candidate -> evidence.
    const candidate = String((pkg.candidate as Record_).commit_sha);
    if (parents.length !== 1 || parents[0] !== candidate) {
      issues.push(`The Evidence Package commit is not directly on its candidate ${candidate}.`);
    } else {
      const candidateParents = await reads.parentsOf(candidate);
      if (candidateParents.length !== 1 || candidateParents[0] !== args.handoff) {
        issues.push(`The candidate ${candidate} is not directly on the handoff ${args.handoff}.`);
      }
    }
  }
  return { pkg, issues };
}

export type EvaluationRoute = "human_approval" | "execution_rework" | "hold_specification" | "hold_policy" | "hold";

/**
 * Stage Contracts §5 routing. Only an implementation (or evidence) defect returns to Execution
 * automatically; a specification or policy defect needs the accountable human.
 */
export function routeEvaluation(status: unknown, findings: unknown): EvaluationRoute {
  if (status === "pass") return "human_approval";
  if (status !== "fail") return "hold";
  const blocking = (Array.isArray(findings) ? findings : []).filter(
    (finding) => (finding as Record_).severity === "blocking",
  ) as Record_[];
  if (blocking.some((finding) => finding.category === "specification")) return "hold_specification";
  if (blocking.some((finding) => finding.category === "policy")) return "hold_policy";
  return blocking.length ? "execution_rework" : "hold";
}

export function stageResultDecision(args: {
  run: StageRun;
  result: Record_;
  disposition: "accepted" | "rejected";
  recordedAt: string;
  reason?: string;
}): Record_ {
  return {
    schema_version: "1.0",
    invocation_id: args.run.result.invocation_id,
    stage: args.run.result.stage,
    work_item: args.run.result.work_item,
    result: args.result,
    disposition: args.disposition,
    recorded_at: args.recordedAt,
    ...(args.reason ? { reason: args.reason } : {}),
  };
}
