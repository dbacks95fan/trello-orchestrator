// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Parses human-record comments and verifies Spec Acceptance against frozen work and GitHub artifacts.
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { LifecycleValidator } from "../contracts/lifecycle.js";
import type { TrelloCard } from "../trello/client.js";
import { activeFreezeForCard } from "./freezeState.js";
import { frozenArtifactSha256, resolveSpecRequest, type ProductConfig } from "./specRequestFromCard.js";
import { validateWorkContractV3 } from "./workContractV3.js";

export const HUMAN_RECORD_MARKER = "<!-- agentic-sdlc-human-record ";

function sameArtifactRef(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return (
    left.repository === right.repository &&
    left.commit_sha === right.commit_sha &&
    left.path === right.path &&
    left.sha256 === right.sha256
  );
}

export function parseHumanRecordComment(text: string): { definition: string; record: unknown } | null {
  if (!text.startsWith(HUMAN_RECORD_MARKER)) return null;
  const end = text.indexOf(" -->");
  if (end < 0) return null;
  try {
    const value = JSON.parse(text.slice(HUMAN_RECORD_MARKER.length, end)) as { definition?: unknown; record?: unknown };
    if (typeof value.definition !== "string" || !("record" in value)) return null;
    return { definition: value.definition, record: value.record };
  } catch {
    return null;
  }
}

export async function readArtifactRef(
  ref: Record<string, unknown>,
  apiBase: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const repository = new URL(String(ref.repository));
  if (repository.protocol !== "https:" || repository.hostname !== "github.com")
    throw new Error("Artifact repository must be an HTTPS GitHub URL.");
  const parts = repository.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("Artifact repository URL must identify one GitHub owner and repository.");
  const path = String(ref.path);
  if (!path || path.startsWith("/") || path.split(/[\\/]/).includes(".."))
    throw new Error("Artifact path must be repository-relative and cannot traverse directories.");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `${apiBase.replace(/\/$/, "")}/repos/${parts[0]}/${parts[1]}/contents/${encodedPath}?ref=${encodeURIComponent(String(ref.commit_sha))}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "trello-orchestrator",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchFn(url, { headers });
  if (!response.ok)
    throw new Error(
      `GitHub could not read ${parts[0]}/${parts[1]}@${String(ref.commit_sha).slice(0, 12)}:${path} (HTTP ${response.status}).`,
    );
  const content = await response.text();
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  if (digest !== ref.sha256) throw new Error(`Artifact hash mismatch for ${path}.`);
  return content;
}

export interface SpecAcceptanceValidationOptions {
  card: TrelloCard;
  actorId: string;
  record: unknown;
  validator: LifecycleValidator;
  productConfig: ProductConfig;
  expectedSpec: Record<string, unknown>;
  expectedWorkContract: Record<string, unknown>;
  expectedTargetCommit: string;
  githubApiBase: string;
  intentBacklogReadToken: string;
  productRepositoryReadToken: string;
  fetchFn?: typeof fetch;
  resolveIntent: typeof resolveSpecRequest;
}

/** Validate the signed-in human's acceptance against the active freeze and the exact committed artifact bytes. */
export async function validateSpecAcceptanceRecord(options: SpecAcceptanceValidationOptions): Promise<string[]> {
  const { card, actorId, record, validator, productConfig } = options;
  const schemaCheck = validator.validate("SpecAcceptanceRecord", record);
  if (!schemaCheck.valid) return [`SpecAcceptanceRecord is invalid: ${schemaCheck.errors.join("; ")}`];
  const value = record as Record<string, unknown>;
  const workItem = value.work_item as Record<string, unknown>;
  const freeze = activeFreezeForCard(card);
  if (!freeze) return ["The card does not have an active Prioritized freeze."];
  if (
    workItem.trello_card_id !== card.id ||
    workItem.product_id !== freeze.tuple.productId ||
    workItem.intent_id !== freeze.tuple.intentId ||
    workItem.intent_version !== freeze.tuple.intentVersion
  )
    return ["The acceptance work_item does not match the active frozen card and intent."];
  if (value.authorized_by !== actorId || !productConfig.authorized_product_owner_ids.includes(actorId)) {
    return ["The acceptance record author must be the authorized product owner who made this board transition."];
  }

  const artifacts = [value.spec, value.work_contract] as Array<Record<string, unknown>>;
  let contents: string[];
  try {
    contents = await Promise.all(
      artifacts.map((artifact) =>
        readArtifactRef(artifact, options.githubApiBase, options.productRepositoryReadToken, options.fetchFn ?? fetch),
      ),
    );
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  let contract: unknown;
  try {
    contract = parseYaml(contents[1]);
  } catch (error) {
    return [
      `The accepted Work Contract could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  let resolved;
  try {
    resolved = await options.resolveIntent(card, {
      githubApiBase: options.githubApiBase,
      intentBacklogReadToken: options.intentBacklogReadToken,
      approvedBy: actorId,
      approvedAt: String(value.recorded_at),
      fetchFn: options.fetchFn,
    });
  } catch (error) {
    return [`The frozen intent could not be verified: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (
    resolved.productId !== freeze.tuple.productId ||
    resolved.intentId !== freeze.tuple.intentId ||
    resolved.intentVersion !== freeze.tuple.intentVersion ||
    resolved.intentCommit !== freeze.tuple.intentCommit ||
    frozenArtifactSha256(resolved.frozenIntentBytes) !== freeze.tuple.intentSha256 ||
    resolved.policyProfileId !== freeze.tuple.policyProfileId ||
    resolved.policyProfileVersion !== freeze.tuple.policyProfileVersion ||
    resolved.policyProfileContentSha256 !== freeze.tuple.policyProfileSha256
  )
    return ["The intent or policy profile no longer matches the active freeze."];
  const specRef = value.spec as Record<string, unknown>;
  const workContractRef = value.work_contract as Record<string, unknown>;
  if (
    !sameArtifactRef(specRef, options.expectedSpec) ||
    !sameArtifactRef(workContractRef, options.expectedWorkContract)
  ) {
    return ["The accepted artifact references do not match the latest validated spec_ready StageResult."];
  }
  if (specRef.repository !== workContractRef.repository || specRef.commit_sha !== workContractRef.commit_sha) {
    return ["The accepted spec and Work Contract must be committed to the same repository revision."];
  }
  const expectedTargetRepo = productConfig.target_repository
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
  const contractTarget = (contract as Record<string, unknown>)?.target as Record<string, unknown> | undefined;
  const issues = validateWorkContractV3(
    contract,
    {
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
      targetRepository: expectedTargetRepo,
      targetCommit: options.expectedTargetCommit,
    },
    validator,
  );
  return issues;
}
