// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Revalidates Spec Acceptance and builds the Coding Agent contract from canonical v3 artifacts.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LifecycleValidator } from "../contracts/lifecycle.js";
import type { TrelloCard } from "../trello/client.js";
import type { WorkContract } from "./contractFromCard.js";
import { activeFreezeForCard } from "./freezeState.js";
import { frozenArtifactSha256, resolveSpecRequest } from "./specRequestFromCard.js";
import { readArtifactRef } from "./humanRecords.js";
import { adaptAcceptedWorkContract } from "./codingContractAdapter.js";
import { readCommittedWorkspaceFile } from "./specWorkspace.js";
import type { WorkContractExpectation } from "./workContractV3.js";

const execFileAsync = promisify(execFile);

export interface AcceptedExecutionContract {
  workContract: WorkContract;
  invocation: Record<string, unknown>;
  repositoryPath: string;
  baseBranch: string;
}

export interface AcceptedExecutionOptions {
  card: TrelloCard;
  acceptance: Record<string, unknown>;
  workspaceRef: string;
  targetCommit: string;
  workspaceRoot: string;
  intentBacklogApiBase: string;
  intentBacklogReadToken: string;
  createProductRepositoryReadToken: (repositoryUrl: string) => Promise<string>;
  freezeActivation: Record<string, unknown>;
  validator: LifecycleValidator;
  fetchFn?: typeof fetch;
  targetRepositoryUrl?: string;
}

/** Recheck frozen and accepted references immediately before constructing the Coding Agent v2 contract. */
export async function loadAcceptedExecutionContract(
  options: AcceptedExecutionOptions,
): Promise<AcceptedExecutionContract> {
  const { card, acceptance, validator } = options;
  const acceptanceValidation = validator.validate("SpecAcceptanceRecord", acceptance);
  if (!acceptanceValidation.valid)
    throw new Error(`SpecAcceptanceRecord is invalid: ${acceptanceValidation.errors.join("; ")}`);
  const freeze = activeFreezeForCard(card);
  if (!freeze) throw new Error("There is no active Prioritized freeze for this card.");
  const workItem = acceptance.work_item as Record<string, unknown>;
  if (
    workItem.product_id !== freeze.tuple.productId ||
    workItem.intent_id !== freeze.tuple.intentId ||
    workItem.intent_version !== freeze.tuple.intentVersion ||
    workItem.trello_card_id !== card.id
  ) {
    throw new Error("The accepted work item no longer matches the active Prioritized freeze.");
  }

  const resolved = await resolveSpecRequest(card, {
    githubApiBase: options.intentBacklogApiBase,
    intentBacklogReadToken: options.intentBacklogReadToken,
    approvedBy: String(acceptance.authorized_by),
    approvedAt: String(acceptance.recorded_at),
    fetchFn: options.fetchFn,
    targetRepositoryUrl: options.targetRepositoryUrl,
  });
  if (!resolved.productConfig.authorized_product_owner_ids.includes(String(acceptance.authorized_by))) {
    throw new Error("The SpecAcceptanceRecord author is not an authorized product owner.");
  }
  const productRepositoryReadToken = await options.createProductRepositoryReadToken(
    resolved.productConfig.target_repository,
  );
  if (
    resolved.intentCommit !== freeze.tuple.intentCommit ||
    frozenArtifactSha256(resolved.frozenIntentBytes) !== freeze.tuple.intentSha256 ||
    resolved.policyProfileId !== freeze.tuple.policyProfileId ||
    resolved.policyProfileVersion !== freeze.tuple.policyProfileVersion ||
    resolved.policyProfileContentSha256 !== freeze.tuple.policyProfileSha256
  )
    throw new Error("The frozen intent or policy profile has changed since Prioritized.");

  if (options.workspaceRef !== `work/${resolved.intentId}`)
    throw new Error("The accepted Spec & Design invocation does not target the expected work branch.");
  const repositoryPath = join(options.workspaceRoot, resolved.intentId);
  const [specText, contractText] = await Promise.all([
    readArtifactRef(
      acceptance.spec as Record<string, unknown>,
      options.intentBacklogApiBase,
      productRepositoryReadToken,
      options.fetchFn,
    ),
    readArtifactRef(
      acceptance.work_contract as Record<string, unknown>,
      options.intentBacklogApiBase,
      productRepositoryReadToken,
      options.fetchFn,
    ),
  ]);
  if (
    String((acceptance.spec as Record<string, unknown>).repository) !==
      String((acceptance.work_contract as Record<string, unknown>).repository) ||
    String((acceptance.spec as Record<string, unknown>).commit_sha) !==
      String((acceptance.work_contract as Record<string, unknown>).commit_sha)
  ) {
    throw new Error("The accepted spec and Work Contract do not share one immutable repository revision.");
  }
  const workContractV3 = parseYaml(contractText) as unknown;
  const target = (workContractV3 as Record<string, unknown>)?.target as Record<string, unknown> | undefined;
  const targetCommit = String(target?.commit_sha ?? "");
  if (targetCommit !== options.targetCommit)
    throw new Error("The accepted Work Contract target commit does not match its StageInvocation.");

  const configuredRepository = resolved.productConfig.target_repository
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
  const { stdout: originOutput } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], {
    cwd: repositoryPath,
    windowsHide: true,
  });
  const origin = originOutput
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
  if (origin !== configuredRepository)
    throw new Error("The isolated Spec & Design workspace origin does not match product.yaml target_repository.");
  const { stdout: branchHead } = await execFileAsync("git", ["rev-parse", options.workspaceRef], {
    cwd: repositoryPath,
    windowsHide: true,
  });
  const { stdout: specCommit } = await execFileAsync(
    "git",
    ["rev-parse", String((acceptance.spec as Record<string, unknown>).commit_sha)],
    { cwd: repositoryPath, windowsHide: true },
  );
  await execFileAsync("git", ["merge-base", "--is-ancestor", specCommit.trim(), branchHead.trim()], {
    cwd: repositoryPath,
    windowsHide: true,
  });

  const frozenIntentPath = `.agent/work/${resolved.intentId}/intent.md`;
  const frozenIntentOnBranch = await readCommittedWorkspaceFile(repositoryPath, branchHead.trim(), frozenIntentPath);
  const expected: WorkContractExpectation = {
    productId: resolved.productId,
    intentId: resolved.intentId,
    intentVersion: resolved.intentVersion,
    cardId: card.id,
    intentRepository: `https://github.com/${resolved.intentRepository}`,
    intentCommit: resolved.intentCommit,
    intentPath: resolved.intentPath,
    intentSha256: frozenArtifactSha256(resolved.frozenIntentBytes),
    policyProfileId: resolved.policyProfileId,
    policyProfileVersion: resolved.policyProfileVersion,
    policyProfilePath: resolved.policyProfilePath,
    policyProfileSha256: resolved.policyProfileContentSha256,
    targetRepository: resolved.productConfig.target_repository.replace(/\.git$/, "").replace(/\/$/, ""),
    targetCommit: options.targetCommit,
  };
  const workContract = adaptAcceptedWorkContract({
    card,
    workContractV3,
    specMarkdown: specText,
    specAcceptance: acceptance,
    frozenIntentPath,
    frozenIntentBytes: Buffer.from(frozenIntentOnBranch, "utf8"),
    targetRepository: expected.targetRepository,
    targetCommit: expected.targetCommit,
    expected,
    validator,
  });
  if (branchHead.trim() !== specCommit.trim())
    throw new Error("The accepted Spec & Design branch moved after the human accepted its artifacts.");
  const invocation = {
    schema_version: "1.1",
    invocation_id: randomUUID(),
    trigger_event_id: randomUUID(),
    stage: "execution",
    work_item: acceptance.work_item,
    freeze_activation: options.freezeActivation,
    input_artifacts: [acceptance.spec, acceptance.work_contract],
    target: { repository: expected.targetRepository, commit_sha: branchHead.trim() },
    workspace_ref: options.workspaceRef,
    read_paths: ["."],
    write_paths: ["."],
  };
  const invocationValidation = validator.validate("StageInvocation", invocation);
  if (!invocationValidation.valid)
    throw new Error(`Execution StageInvocation is invalid: ${invocationValidation.errors.join("; ")}`);
  return { workContract, invocation, repositoryPath, baseBranch: options.workspaceRef };
}
