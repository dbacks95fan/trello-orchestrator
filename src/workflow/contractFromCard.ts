import type { TrelloCard } from "../trello/client.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

export interface WorkContract {
  schema_version: 2;
  work_item: string;
  objective: string;
  acceptance_criteria: Record<string, string>;
  required_validation: string[];
  non_goals?: string[];
  constraints?: string[];
  intent: {
    path: string;
    revision: string;
    sha256: string;
    reviewUrl: string;
    status: "Accepted";
    acceptedBy: string;
    acceptedAt: string;
  };
  board: {
    provider: "trello";
    workItemId: string;
    workItemUrl: string;
    workItemType: "User Story" | "Feature" | "Epic" | "Technical Enabler";
  };
}

export class CardParseError extends Error {}

/** Canonical section name -> accepted heading spellings seen on this board so far.
 *  Add aliases here as new phrasing shows up rather than requiring cards to match
 *  one exact convention. */
const SECTION_ALIASES: Record<string, string[]> = {
  "USER STORY": ["USER STORY"],
  "ACCEPTANCE CRITERIA": ["ACCEPTANCE CRITERIA"],
  "PLAYWRIGHT TEST CASES": ["PLAYWRIGHT TEST CASES", "PLAYWRIGHT"],
  "DEFINITION OF DONE": ["DEFINITION OF DONE", "DONE"],
  CONSTRAINTS: ["CONSTRAINTS"],
  "NON-GOALS": ["NON-GOALS", "NON GOALS", "OUT OF SCOPE"],
  "CANONICAL INTENT PATH": ["CANONICAL INTENT PATH", "INTENT PATH"],
};

const ALL_KNOWN_HEADINGS = new Set(Object.values(SECTION_ALIASES).flat());

function canonicalHeading(line: string): string | null {
  const upper = line.toUpperCase();
  for (const [canonical, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.includes(upper)) return canonical;
  }
  return null;
}

/** A line that reads as SOME kind of section heading (all-caps, short, no bullet
 *  marker) even if we don't recognize which one — used only to stop a heading we
 *  DO know from silently absorbing content that belongs to a heading we don't. */
function looksLikeUnknownHeading(line: string): boolean {
  if (ALL_KNOWN_HEADINGS.has(line.toUpperCase())) return false; // handled elsewhere
  return (
    line.length > 0 && line.length <= 40 && !line.startsWith("-") && line === line.toUpperCase() && /[A-Z]/.test(line)
  );
}

/** Splits a card description into named sections. Recognizes several heading
 *  spellings per section (SECTION_ALIASES) and — critically — stops accumulating
 *  into a recognized section as soon as ANY heading-shaped line appears, known or
 *  not, so content under a heading we don't map to anything doesn't silently leak
 *  into whichever recognized section happened to come before it. */
function splitSections(desc: string): Record<string, string[]> {
  const lines = desc.split(/\r?\n/);
  const sections: Record<string, string[]> = {};
  let current: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const heading = canonicalHeading(line);
    if (heading) {
      current = heading;
      sections[current] ??= [];
      continue;
    }

    if (looksLikeUnknownHeading(line)) {
      current = null; // unrecognized section — stop feeding the previous one
      continue;
    }

    if (!current || !line) continue;

    if (line.startsWith("-")) {
      sections[current].push(line.replace(/^-\s*/, "").trim());
    } else {
      // Non-bullet prose line (e.g. the USER STORY paragraph) — accumulate as text.
      sections[current].push(line);
    }
  }

  return sections;
}

/**
 * Deterministic, non-LLM translation of an already-Planner-authored Trello card
 * into a Work Contract. This is NOT the Codex Planner — it does not originate
 * requirements or use judgment about what "should" be tested; it only reformats
 * structure that a human (or eventually Codex) already wrote. If the expected
 * structure isn't there, it fails loudly rather than guessing.
 */
function intentValue(markdown: string, label: string): string | undefined {
  return markdown.match(new RegExp(`^-\\s*\\*\\*${label}:\\*\\*\\s*(.+)$`, "mi"))?.[1]?.trim();
}

function readAcceptedIntent(repoRoot: string, requestedPath: string, expectedWorkItem: string) {
  const path = resolve(repoRoot, requestedPath);
  const root = resolve(repoRoot);
  if (!path.startsWith(root + sep)) throw new CardParseError("Canonical intent path escapes TARGET_REPO.");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new CardParseError(`Canonical intent file '${requestedPath}' is not available in TARGET_REPO.`);
  }
  const workItem = intentValue(raw, "Work ID");
  const status = intentValue(raw, "Status");
  const reviewUrl = intentValue(raw, "Review URL");
  const acceptedBy = intentValue(raw, "Accepted by");
  const acceptedAt = intentValue(raw, "Accepted at");
  if (workItem !== expectedWorkItem)
    throw new CardParseError(`Intent Work ID '${workItem ?? "missing"}' does not match '${expectedWorkItem}'.`);
  if (status !== "Accepted" || !reviewUrl || !acceptedBy || !acceptedAt)
    throw new CardParseError("Canonical intent is not accepted with complete review metadata.");
  const openDecisions = raw.match(/## Open decisions\s*\n([\s\S]*?)(?=\n## |$)/i)?.[1] ?? "";
  if (/^\s*-\s+.+$/m.test(openDecisions)) throw new CardParseError("Canonical intent has unresolved open decisions.");
  const relativePath = relative(root, path).replace(/\\/g, "/");
  let revision: string;
  try {
    const tracked = execFileSync("git", ["show", `HEAD:${relativePath}`], { cwd: root, encoding: "utf8" });
    if (tracked !== raw) throw new Error("not pinned");
    revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    throw new CardParseError("Canonical intent must be committed at the revision used for the Work Contract.");
  }
  return {
    path: relativePath,
    revision,
    sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    reviewUrl,
    status: "Accepted" as const,
    acceptedBy,
    acceptedAt,
  };
}

export function contractFromCard(card: TrelloCard, repoRoot: string): WorkContract {
  const sections = splitSections(card.desc);

  const userStory = sections["USER STORY"]?.join(" ").trim();
  if (!userStory) {
    throw new CardParseError(
      `Card "${card.name}" has no USER STORY section — cannot derive an objective without guessing.`,
    );
  }

  const acBullets = sections["ACCEPTANCE CRITERIA"] ?? [];
  if (acBullets.length === 0) {
    throw new CardParseError(
      `Card "${card.name}" has no ACCEPTANCE CRITERIA bullets — refusing to invent requirements.`,
    );
  }

  const acceptance_criteria: Record<string, string> = {};
  acBullets.forEach((text, i) => {
    acceptance_criteria[`AC${i + 1}`] = text;
  });

  const required_validation = ["build", "automated_tests"];
  if ((sections["PLAYWRIGHT TEST CASES"] ?? []).length > 0) {
    required_validation.push("playwright");
  }
  const dod = (sections["DEFINITION OF DONE"] ?? []).join(" ");
  if (/docker/i.test(dod)) {
    required_validation.push("docker_build");
  }

  const non_goals = sections["NON-GOALS"] ?? [];
  const constraints = sections["CONSTRAINTS"] ?? [];
  const workItem = `TRELLO-${card.idShort}`;
  const intentPath = sections["CANONICAL INTENT PATH"]?.join(" ").trim();
  if (!intentPath)
    throw new CardParseError(
      `Card "${card.name}" has no CANONICAL INTENT PATH — refusing to reconstruct intent from the card.`,
    );
  const intent = readAcceptedIntent(repoRoot, intentPath, workItem);
  const workItemType = card.name.startsWith("[Epic]")
    ? "Epic"
    : card.name.startsWith("[Feature]")
      ? "Feature"
      : card.name.startsWith("[Enabler]")
        ? "Technical Enabler"
        : "User Story";

  return {
    schema_version: 2,
    work_item: workItem,
    objective: userStory,
    acceptance_criteria,
    required_validation,
    ...(non_goals.length ? { non_goals } : {}),
    ...(constraints.length ? { constraints } : {}),
    intent,
    board: { provider: "trello", workItemId: workItem, workItemUrl: card.url, workItemType },
  };
}
