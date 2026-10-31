// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Validates a proposed Work Contract v3 against the active frozen work item.
import type { LifecycleValidator } from "../contracts/lifecycle.js";

export interface WorkContractExpectation {
  productId: string;
  intentId: string;
  intentVersion: number;
  cardId: string;
  intentRepository: string;
  intentCommit: string;
  intentPath: string;
  intentSha256: string;
  policyProfileId: string;
  policyProfileVersion: string;
  policyProfilePath: string;
  policyProfileSha256: string;
  targetRepository: string;
  targetCommit: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function equalArtifact(
  value: unknown,
  expected: { repository: string; commit_sha: string; path: string; sha256: string },
): boolean {
  const artifact = record(value);
  return (
    artifact?.repository === expected.repository &&
    artifact.commit_sha === expected.commit_sha &&
    artifact.path === expected.path &&
    artifact.sha256 === expected.sha256
  );
}

/** Return all schema and frozen-reference mismatches; any mismatch blocks spec acceptance. */
export function validateWorkContractV3(
  value: unknown,
  expected: WorkContractExpectation,
  validator: LifecycleValidator,
): string[] {
  const validation = validator.validate("WorkContract", value);
  const issues = validation.valid ? [] : [`Work Contract v3 schema validation failed: ${validation.errors.join("; ")}`];
  const contract = record(value);
  if (!contract) return issues;
  const workItem = record(contract.work_item);
  const target = record(contract.target);
  if (
    workItem?.product_id !== expected.productId ||
    workItem.intent_id !== expected.intentId ||
    workItem.intent_version !== expected.intentVersion ||
    workItem.trello_card_id !== expected.cardId
  )
    issues.push("The Work Contract work_item does not match the active product, intent, version, and Trello card.");
  if (
    !equalArtifact(contract.intent, {
      repository: expected.intentRepository,
      commit_sha: expected.intentCommit,
      path: expected.intentPath,
      sha256: expected.intentSha256,
    })
  )
    issues.push("The Work Contract intent reference does not match the frozen intent.");
  if (
    contract.policy_profile_id !== expected.policyProfileId ||
    contract.policy_profile_version !== expected.policyProfileVersion ||
    !equalArtifact(contract.policy_profile, {
      repository: expected.intentRepository,
      commit_sha: expected.intentCommit,
      path: expected.policyProfilePath,
      sha256: expected.policyProfileSha256,
    })
  )
    issues.push("The Work Contract policy profile reference does not match the frozen profile.");
  if (target?.repository !== expected.targetRepository || target.commit_sha !== expected.targetCommit) {
    issues.push("The Work Contract target repository and base revision do not match the assigned workspace.");
  }
  return issues;
}
