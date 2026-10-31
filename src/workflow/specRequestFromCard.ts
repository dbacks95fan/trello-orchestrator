// ABOUTME: Resolves a Spec & Design work request from a Trello card and the intent in intent-backlog.
import type { ProductBoardConfig, TrelloCard } from "../trello/client.js";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { config } from "../config.js";
import { createLifecycleValidator } from "../contracts/lifecycle.js";

const lifecycleValidator = createLifecycleValidator(config.lifecycleSchemaPath);
export interface ProductConfig extends ProductBoardConfig {
  product_id: string;
  product_name: string;
  target_repository: string;
  authorized_product_owner_ids: string[];
  policy_profiles: Record<string, string>;
}

/** Raised when a card in Spec & Design does not carry a usable intent
 *  reference. The workflow turns this into a card comment and leaves the card
 *  in place rather than starting the agent from a guess. */
export class SpecRequestError extends Error {}

/** The identifier shape the Spec & Design Agent's request schema requires for
 *  `workItem` (e.g. INT-MF-0042). */
const INTENT_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const CONTENT_HASH = /^(?:sha256:)?([0-9a-f]{64})$/;

/** The Intent Creation Skill projects these lines into the card description
 *  (intent-creation-skill/references/work-tracking.md, "Trello card contract").
 *  Labels are matched case-insensitively and tolerate surrounding `**` bold. */
interface CardIntentMetadata {
  productId: string;
  intentId: string;
  intentVersion: number;
  intentCommit: string;
  intentContentSha256: string;
  intentStatus: string;
  canonicalIntentUrl: string;
  policyProfileId: string;
  policyProfileVersion: string;
}

export interface ResolvedSpecRequest {
  intentId: string;
  productId: string;
  intentVersion: number;
  intentCommit: string;
  intentContentSha256: string;
  intentRepository: string;
  intentPath: string;
  frozenIntentBytes: Buffer;
  approvedBy: string;
  approvedAt: string;
  warnings: string[];
  policyProfileId: string;
  policyProfileVersion: string;
  policyProfilePath: string;
  policyProfileContentSha256: string;
  frozenPolicyProfileBytes: Buffer;
  productConfig: ProductConfig;
}

export interface ResolveSpecRequestOptions {
  githubApiBase: string;
  intentBacklogReadToken: string;
  approvedBy: string;
  approvedAt: string;
  /** Test seam for an isolated local fixture; production reads targetRepo's Git origin. */
  targetRepositoryUrl?: string;
  fetchFn?: typeof fetch;
}

/** Reads a `Label: value` line from the card description, tolerating a leading
 *  list marker and Markdown bold around the label and/or the colon
 *  (`- **Intent ID:** X`, `**Intent ID**: X`, `Intent ID: X`). The value itself
 *  may contain colons (URLs), so only the first colon is treated as separator. */
function metadataValue(desc: string, label: string): string | undefined {
  const wanted = label.toLowerCase();
  for (const raw of desc.split(/\r?\n/)) {
    const cleaned = raw
      .replace(/\*\*/g, "")
      .replace(/^\s*[-*+]\s+/, "")
      .trim();
    const colon = cleaned.indexOf(":");
    if (colon === -1) continue;
    if (cleaned.slice(0, colon).trim().toLowerCase() !== wanted) continue;
    const value = cleaned.slice(colon + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

export function parseCardIntentMetadata(card: TrelloCard): CardIntentMetadata {
  const desc = card.desc ?? "";
  // `Product: MealFlow (MF)` is the canonical projection, but cards in the wild
  // also carry the id on its own line as `Product ID: MF`. Both are unambiguous.
  const productLine = metadataValue(desc, "Product");
  const productId = productLine?.match(/\(([^)]+)\)\s*$/)?.[1]?.trim() ?? metadataValue(desc, "Product ID");
  const intentId = metadataValue(desc, "Intent ID");
  const versionRaw = metadataValue(desc, "Intent Version");
  const intentCommit = metadataValue(desc, "Intent Commit")?.toLowerCase();
  const hashRaw = metadataValue(desc, "Intent Hash");
  const intentStatus = metadataValue(desc, "Intent Status");
  const canonicalIntentUrl = metadataValue(desc, "Canonical intent");
  const policyProfileId = metadataValue(desc, "Policy Profile ID");
  const policyProfileVersion = metadataValue(desc, "Policy Profile Version");

  const missing = Object.entries({
    "Product (as `Product: Name (ID)` or `Product ID: ID`)": productId,
    "Intent ID": intentId,
    "Intent Version": versionRaw,
    "Intent Commit": intentCommit,
    "Intent Hash": hashRaw,
    "Canonical intent": canonicalIntentUrl,
    "Policy Profile ID": policyProfileId,
    "Policy Profile Version": policyProfileVersion,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new SpecRequestError(
      `Card "${card.name}" is missing intent metadata the Intent Creation Skill is expected to project onto the card: ${missing.join(", ")}.`,
    );
  }

  if (!INTENT_ID.test(intentId!)) {
    throw new SpecRequestError(`Intent ID "${intentId}" is not a product-prefixed identifier such as INT-MF-0042.`);
  }
  const intentVersion = Number(versionRaw);
  if (!Number.isInteger(intentVersion) || intentVersion < 1) {
    throw new SpecRequestError(`Intent Version "${versionRaw}" is not a positive integer.`);
  }
  if (!FULL_SHA.test(intentCommit!)) {
    throw new SpecRequestError(`Intent Commit "${intentCommit}" is not a full 40-character Git SHA.`);
  }
  const contentHash = hashRaw!.match(CONTENT_HASH)?.[1];
  if (!contentHash) {
    throw new SpecRequestError(`Intent Hash "${hashRaw}" is not a sha256 content hash.`);
  }
  // Intent Status is read for reconciliation but not treated as authorization.
  // The Orchestrator enforces the Prioritized freeze before this resolver is called.
  return {
    productId: productId!,
    intentId: intentId!,
    intentVersion,
    intentCommit: intentCommit!,
    intentContentSha256: contentHash,
    intentStatus: intentStatus ?? "",
    canonicalIntentUrl: canonicalIntentUrl!,
    policyProfileId: policyProfileId!,
    policyProfileVersion: policyProfileVersion!,
  };
}

interface CanonicalLocation {
  owner: string;
  repo: string;
  path: string;
}

export function parseCanonicalIntentUrl(url: string): CanonicalLocation {
  const patterns = [
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/[^/]+\/(.+?)(?:[?#].*)?$/,
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/(.+?)(?:[?#].*)?$/,
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+?)(?:[?&].*)?$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return { owner: match[1], repo: match[2], path: decodeURIComponent(match[3]) };
  }
  throw new SpecRequestError(`Canonical intent URL is not a recognised GitHub file URL: ${url}`);
}

async function fetchFrozenIntent(
  location: CanonicalLocation,
  ref: string,
  options: ResolveSpecRequestOptions,
): Promise<Buffer> {
  const encodedPath = location.path.split("/").map(encodeURIComponent).join("/");
  const url = `${options.githubApiBase.replace(/\/$/, "")}/repos/${location.owner}/${location.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "trello-orchestrator",
  };
  if (options.intentBacklogReadToken) headers.Authorization = `Bearer ${options.intentBacklogReadToken}`;

  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const hint =
      response.status === 404 || response.status === 401 || response.status === 403
        ? " If intent-backlog is private, set INTENT_BACKLOG_READ_TOKEN in the shared runtime file."
        : ` ${body.slice(0, 200)}`;
    throw new SpecRequestError(
      `GitHub returned HTTP ${response.status} fetching the frozen intent ${location.owner}/${location.repo}@${ref.slice(0, 12)} ${location.path}.${hint}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchFrozenFile(
  location: CanonicalLocation,
  path: string,
  ref: string,
  options: ResolveSpecRequestOptions,
): Promise<Buffer> {
  return fetchFrozenIntent({ ...location, path }, ref, options);
}

function frozenIntentFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new SpecRequestError("The frozen intent.md has no YAML frontmatter to verify identity against.");
  const parsed = parseYaml(match[1]);
  if (!parsed || typeof parsed !== "object") {
    throw new SpecRequestError("The frozen intent.md frontmatter did not parse as a mapping.");
  }
  return parsed as Record<string, unknown>;
}

function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/** Reads the first frontmatter key that is present. `agentic-sdlc/docs/ARTIFACTS.md`
 *  makes `intent_commit` / `intent_hash` canonical and forbids local aliases, but
 *  existing backlog artifacts were written with `git_commit` / `content_hash`.
 *  Accepting both keeps the canonical name authoritative while still reading the
 *  intents that already exist. */
function frontmatterValue(fm: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = str(fm[name]);
    if (value) return value;
  }
  return "";
}

/** Resolves and integrity-checks the frozen intent a Spec & Design run needs.
 *  Strong disagreements between the card projection and the canonical artifact
 *  throw; softer ones (self-referential commit field, card-id spelling) are
 *  returned as warnings for the workflow to surface on the card. */
export async function resolveSpecRequest(
  card: TrelloCard,
  options: ResolveSpecRequestOptions,
): Promise<ResolvedSpecRequest> {
  const meta = parseCardIntentMetadata(card);
  const location = parseCanonicalIntentUrl(meta.canonicalIntentUrl);
  const frozenIntentBytes = await fetchFrozenIntent(location, meta.intentCommit, options);
  const fm = frozenIntentFrontmatter(frozenIntentBytes.toString("utf8"));

  const mismatches: string[] = [];
  if (str(fm.intent_id) !== meta.intentId)
    mismatches.push(`intent_id (card ${meta.intentId} vs backlog ${str(fm.intent_id) || "missing"})`);
  if (str(fm.product_id) !== meta.productId)
    mismatches.push(`product_id (card ${meta.productId} vs backlog ${str(fm.product_id) || "missing"})`);
  if (Number(fm.intent_version) !== meta.intentVersion)
    mismatches.push(`intent_version (card ${meta.intentVersion} vs backlog ${str(fm.intent_version) || "missing"})`);
  const backlogHash = frontmatterValue(fm, "intent_hash", "content_hash").match(CONTENT_HASH)?.[1];
  if (backlogHash !== meta.intentContentSha256)
    mismatches.push("intent_hash (card projection and backlog artifact disagree)");
  if (str(fm.policy_profile_id) !== meta.policyProfileId)
    mismatches.push("policy_profile_id (card projection and backlog artifact disagree)");
  if (str(fm.policy_profile_version) !== meta.policyProfileVersion)
    mismatches.push("policy_profile_version (card projection and backlog artifact disagree)");
  if (mismatches.length > 0) {
    throw new SpecRequestError(
      `The Trello card and the canonical intent.md disagree and must be reconciled before Spec & Design starts: ${mismatches.join("; ")}.`,
    );
  }

  const productMatch = location.path.match(/^(.*?products\/([^/]+))\//);
  if (!productMatch)
    throw new SpecRequestError(
      "Canonical intent path must be inside products/<product>/ so the selected policy profile can be resolved.",
    );
  const productRoot = productMatch[1];
  const productConfigBytes = await fetchFrozenFile(location, `${productRoot}/product.yaml`, meta.intentCommit, options);
  const parsedProductConfig = parseYaml(productConfigBytes.toString("utf8"));
  const productConfigCheck = lifecycleValidator.validate("ProductConfig", parsedProductConfig);
  if (!productConfigCheck.valid) {
    throw new SpecRequestError(`product.yaml is not a valid ProductConfig: ${productConfigCheck.errors.join("; ")}`);
  }
  const productConfig = parsedProductConfig as ProductConfig;
  if (productConfig.product_id !== meta.productId) {
    throw new SpecRequestError(
      `product.yaml product_id "${productConfig.product_id}" does not match the card's Product ID "${meta.productId}".`,
    );
  }
  const configuredTargetUrl = options.targetRepositoryUrl
    ?.replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
  if (
    configuredTargetUrl &&
    productConfig.target_repository
      .replace(/\.git$/, "")
      .replace(/\/$/, "")
      .toLowerCase() !== configuredTargetUrl
  ) {
    throw new SpecRequestError(
      "product.yaml target_repository does not match the configured target repository's origin URL.",
    );
  }
  if (card.idBoard && productConfig.trello_board_id !== card.idBoard) {
    throw new SpecRequestError("product.yaml trello_board_id does not match the Trello card's board.");
  }
  const profiles = productConfig.policy_profiles;
  const profileRelativePath = profiles?.[meta.policyProfileId];
  if (
    typeof profileRelativePath !== "string" ||
    !profileRelativePath ||
    profileRelativePath.startsWith("/") ||
    profileRelativePath.split("/").includes("..")
  ) {
    throw new SpecRequestError(
      `product.yaml does not map policy profile ID "${meta.policyProfileId}" to a safe repository-relative path.`,
    );
  }
  const policyProfilePath = `${productRoot}/${profileRelativePath}`;
  const frozenPolicyProfileBytes = await fetchFrozenFile(location, policyProfilePath, meta.intentCommit, options);
  const profileText = frozenPolicyProfileBytes.toString("utf8");
  const profileId = profileText.match(/^Profile ID:\s*(.+?)\s*$/m)?.[1];
  const profileVersion = profileText.match(/^Version:\s*(.+?)\s*$/m)?.[1];
  if (profileId !== meta.policyProfileId || profileVersion !== meta.policyProfileVersion) {
    throw new SpecRequestError(
      "The selected policy profile ID/version does not match its profile document at the pinned intent commit.",
    );
  }

  const warnings: string[] = [];
  // Status is surfaced, never gated on. The card and the artifact disagreeing about
  // lifecycle state is worth a reviewer's attention but does not stop the run.
  const backlogStatus = str(fm.status);
  if (meta.intentStatus && backlogStatus && backlogStatus.toLowerCase() !== meta.intentStatus.toLowerCase()) {
    warnings.push(
      `The card records Intent Status "${meta.intentStatus}" but the canonical intent.md records "${backlogStatus}".`,
    );
  }
  const backlogCommit = frontmatterValue(fm, "intent_commit", "git_commit").toLowerCase();
  if (backlogCommit && backlogCommit !== meta.intentCommit) {
    warnings.push(
      `The canonical intent.md records intent_commit ${backlogCommit.slice(0, 12)} but the card pins ${meta.intentCommit.slice(0, 12)}; using the card's commit. This is expected when the hash-bearing commit cannot contain its own SHA.`,
    );
  }
  const backlogCardId = str(fm.trello_card_id);
  if (
    backlogCardId &&
    ![card.id, String(card.idShort), card.shortLink].includes(backlogCardId) &&
    !card.url.includes(backlogCardId)
  ) {
    warnings.push(
      `The canonical intent.md records trello_card_id "${backlogCardId}" which does not obviously match this card (${card.idShort}).`,
    );
  }

  let approvedAt = options.approvedAt;
  const frozenAt = str(fm.frozen_at);
  if (frozenAt && !Number.isNaN(Date.parse(frozenAt))) approvedAt = frozenAt;

  return {
    intentId: meta.intentId,
    productId: meta.productId,
    intentVersion: meta.intentVersion,
    intentCommit: meta.intentCommit,
    intentContentSha256: meta.intentContentSha256,
    intentRepository: `${location.owner}/${location.repo}`,
    intentPath: location.path,
    frozenIntentBytes,
    approvedBy: options.approvedBy,
    approvedAt,
    warnings,
    policyProfileId: meta.policyProfileId,
    policyProfileVersion: meta.policyProfileVersion,
    policyProfilePath,
    policyProfileContentSha256: frozenArtifactSha256(frozenPolicyProfileBytes),
    frozenPolicyProfileBytes,
    productConfig,
  };
}

/** Convenience used by tests and callers that already hold the frozen bytes. */
export function frozenArtifactSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
