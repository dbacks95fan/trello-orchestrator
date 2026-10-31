// ABOUTME: Unit tests for resolving and integrity-checking a Spec & Design request from a Trello card.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { TrelloCard } from "../trello/client.js";
import {
  frozenArtifactSha256,
  parseCanonicalIntentUrl,
  parseCardIntentMetadata,
  resolveSpecRequest,
  SpecRequestError,
} from "./specRequestFromCard.js";

const COMMIT = "a".repeat(40);
const PATH = "products/mealflow/intents/INT-MF-0042/intent.md";
const CANONICAL = `https://github.com/dbacks95fan/intent-backlog/blob/${COMMIT}/${PATH}`;
const PROFILE = "Profile ID: MF-DEFAULT\nVersion: 1\n";

function intentMarkdown(overrides: Record<string, string> = {}): string {
  const fm: Record<string, string> = {
    intent_id: "INT-MF-0042",
    product_id: "MF",
    product_name: "MealFlow",
    trello_card_id: "card-long-id",
    intent_version: "3",
    status: "Frozen",
    intent_commit: COMMIT,
    intent_hash: `sha256:${"d".repeat(64)}`,
    policy_profile_id: "MF-DEFAULT",
    policy_profile_version: "1",
    frozen_at: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
  return (
    "---\n" +
    Object.entries(fm)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n") +
    "\n---\n\n# Intent: Meal planner\n"
  );
}

function card(desc: string): TrelloCard {
  return {
    id: "card-long-id",
    idShort: 42,
    name: "[Feature] Weekly meal planner",
    desc,
    idList: "list-1",
    shortLink: "abc123",
    url: "https://trello.com/c/abc123/42-weekly-meal-planner",
  };
}

function description(overrides: Record<string, string> = {}): string {
  const lines: Record<string, string> = {
    Product: "MealFlow (MF)",
    "Intent ID": "INT-MF-0042",
    "Intent Version": "3",
    "Intent Commit": COMMIT,
    "Intent Hash": `sha256:${"d".repeat(64)}`,
    "Intent Status": "Frozen",
    "Canonical intent": CANONICAL,
    "Policy Profile ID": "MF-DEFAULT",
    "Policy Profile Version": "1",
    ...overrides,
  };
  return [
    ...Object.entries(lines).map(([k, v]) => `${k}: ${v}`),
    "",
    "## Problem",
    "Planning meals weekly is tedious.",
  ].join("\n");
}

function stubFetch(body: string, init: ResponseInit = { status: 200 }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/product.yaml?"))
      return new Response(
        'schema_version: "1.1"\nproduct_id: MF\nproduct_name: MealFlow\ntrello_board_id: board-1\ntrello_lists:\n  new_ideas: list-new\n  backlog: list-backlog\n  prioritized: list-prioritized\n  spec_design: list-spec\n  execution: list-execution\n  evaluation: list-evaluation\n  human_approval: list-human-approval\n  release: list-release\n  production_observation: list-observation\n  done: list-done\ntarget_repository: https://github.com/example/mealflow\nauthorized_product_owner_ids:\n  - owner-1\npolicy_profiles:\n  MF-DEFAULT: policy-profiles/default.md\n',
        init,
      );
    if (url.includes("/policy-profiles/default.md?")) return new Response(PROFILE, init);
    return new Response(body, init);
  }) as typeof fetch;
}

const baseOptions = {
  githubApiBase: "https://api.github.com",
  intentBacklogReadToken: "",
  approvedBy: "Sobe",
  approvedAt: "2026-09-06T09:00:00.000Z",
  targetRepositoryUrl: "https://github.com/example/mealflow",
};

test("parseCardIntentMetadata reads the Intent Creation Skill card projection", () => {
  const meta = parseCardIntentMetadata(card(description()));
  assert.equal(meta.productId, "MF");
  assert.equal(meta.intentId, "INT-MF-0042");
  assert.equal(meta.intentVersion, 3);
  assert.equal(meta.intentCommit, COMMIT);
  assert.equal(meta.intentContentSha256, "d".repeat(64));
  assert.equal(meta.intentStatus, "Frozen");
});

test("parseCardIntentMetadata tolerates markdown bold labels and bullets", () => {
  const desc = description().replace("Intent ID: INT-MF-0042", "- **Intent ID:** INT-MF-0042");
  assert.equal(parseCardIntentMetadata(card(desc)).intentId, "INT-MF-0042");
});

test("parseCardIntentMetadata rejects a card missing projected metadata", () => {
  const desc = description()
    .split("\n")
    .filter((line) => !line.startsWith("Intent ID:"))
    .join("\n");
  assert.throws(
    () => parseCardIntentMetadata(card(desc)),
    (err: Error) => err instanceof SpecRequestError && /Intent ID/.test(err.message),
  );
});

test("parseCardIntentMetadata leaves freeze authorization to the Orchestrator", () => {
  for (const status of ["New Ideas", "Refining", "Accepted", "Frozen"]) {
    const meta = parseCardIntentMetadata(card(description({ "Intent Status": status })));
    assert.equal(meta.intentStatus, status);
    assert.equal(meta.intentId, "INT-MF-0042");
  }
});

test("parseCardIntentMetadata accepts a card with no Intent Status at all", () => {
  const desc = description()
    .split("\n")
    .filter((line) => !line.startsWith("Intent Status:"))
    .join("\n");
  const meta = parseCardIntentMetadata(card(desc));
  assert.equal(meta.intentStatus, "");
  assert.equal(meta.intentId, "INT-MF-0042");
});

test("parseCardIntentMetadata rejects a malformed commit or hash", () => {
  assert.throws(() => parseCardIntentMetadata(card(description({ "Intent Commit": "abc123" }))), SpecRequestError);
  assert.throws(() => parseCardIntentMetadata(card(description({ "Intent Hash": "not-a-hash" }))), SpecRequestError);
});

test("parseCanonicalIntentUrl accepts blob, raw, and API URLs", () => {
  assert.deepEqual(parseCanonicalIntentUrl(CANONICAL), { owner: "dbacks95fan", repo: "intent-backlog", path: PATH });
  assert.deepEqual(
    parseCanonicalIntentUrl(`https://raw.githubusercontent.com/dbacks95fan/intent-backlog/${COMMIT}/${PATH}`),
    { owner: "dbacks95fan", repo: "intent-backlog", path: PATH },
  );
  assert.deepEqual(
    parseCanonicalIntentUrl(`https://api.github.com/repos/dbacks95fan/intent-backlog/contents/${PATH}?ref=${COMMIT}`),
    { owner: "dbacks95fan", repo: "intent-backlog", path: PATH },
  );
  assert.throws(() => parseCanonicalIntentUrl("https://example.com/x"), SpecRequestError);
});

test("resolveSpecRequest returns a request grounded in the fetched frozen intent", async () => {
  const markdown = intentMarkdown();
  const resolved = await resolveSpecRequest(card(description()), { ...baseOptions, fetchFn: stubFetch(markdown) });

  assert.equal(resolved.intentId, "INT-MF-0042");
  assert.equal(resolved.productId, "MF");
  assert.equal(resolved.intentRepository, "dbacks95fan/intent-backlog");
  assert.equal(resolved.intentPath, PATH);
  assert.equal(resolved.intentContentSha256, "d".repeat(64));
  assert.deepEqual(resolved.frozenIntentBytes, Buffer.from(markdown));
  assert.equal(resolved.policyProfileId, "MF-DEFAULT");
  assert.deepEqual(resolved.frozenPolicyProfileBytes, Buffer.from(PROFILE));
  assert.equal(frozenArtifactSha256(resolved.frozenIntentBytes), createHash("sha256").update(markdown).digest("hex"));
  // frozen_at from the artifact wins over the Trello move timestamp
  assert.equal(resolved.approvedAt, "2026-08-01T12:00:00.000Z");
  assert.equal(resolved.approvedBy, "Sobe");
  assert.deepEqual(resolved.warnings, []);
});

test("resolveSpecRequest sends bearer auth and pins the ref to the card commit", async () => {
  let seenUrl = "";
  let seenAuth: string | null = null;
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (url.includes("intent.md?")) seenUrl = url;
    seenAuth = new Headers(init.headers).get("authorization");
    return stubFetch(intentMarkdown())(url, init);
  }) as unknown as typeof fetch;

  await resolveSpecRequest(card(description()), {
    ...baseOptions,
    intentBacklogReadToken: "read-only-intent-token",
    fetchFn,
  });
  assert.match(
    seenUrl,
    /\/repos\/dbacks95fan\/intent-backlog\/contents\/products\/mealflow\/intents\/INT-MF-0042\/intent\.md\?ref=a{40}$/,
  );
  assert.equal(seenAuth, "Bearer read-only-intent-token");
});

test("resolveSpecRequest fails when the card and the canonical intent disagree", async () => {
  await assert.rejects(
    resolveSpecRequest(card(description()), {
      ...baseOptions,
      fetchFn: stubFetch(intentMarkdown({ intent_id: "INT-MF-9999" })),
    }),
    (err: Error) => err instanceof SpecRequestError && /disagree/.test(err.message) && /intent_id/.test(err.message),
  );

  await assert.rejects(
    resolveSpecRequest(card(description()), {
      ...baseOptions,
      fetchFn: stubFetch(intentMarkdown({ intent_hash: `sha256:${"e".repeat(64)}` })),
    }),
    (err: Error) => err instanceof SpecRequestError && /intent_hash/.test(err.message),
  );
});

test("resolveSpecRequest warns but proceeds on a self-referential commit field", async () => {
  const resolved = await resolveSpecRequest(card(description()), {
    ...baseOptions,
    fetchFn: stubFetch(intentMarkdown({ intent_commit: "b".repeat(40) })),
  });
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /intent_commit/);
});

test("resolveSpecRequest surfaces a GitHub fetch failure as a SpecRequestError", async () => {
  await assert.rejects(
    resolveSpecRequest(card(description()), { ...baseOptions, fetchFn: stubFetch("Not Found", { status: 404 }) }),
    (err: Error) =>
      err instanceof SpecRequestError && /HTTP 404/.test(err.message) && /INTENT_BACKLOG_READ_TOKEN/.test(err.message),
  );
});

test("parseCardIntentMetadata accepts a card that carries the id as `Product ID:`", () => {
  // The shape real cards use, seen on the MealFlow board.
  const desc = description().replace("Product: MealFlow (MF)", "**Product ID:** MF");
  assert.equal(parseCardIntentMetadata(card(desc)).productId, "MF");
});

test("parseCardIntentMetadata still prefers the parenthesised canonical form", () => {
  const desc = `${description()}\nProduct ID: ZZ`;
  assert.equal(parseCardIntentMetadata(card(desc)).productId, "MF");
});

test("parseCardIntentMetadata accepts an Intent Hash with no sha256: prefix", () => {
  const desc = description({ "Intent Hash": "d".repeat(64) });
  assert.equal(parseCardIntentMetadata(card(desc)).intentContentSha256, "d".repeat(64));
});

test("resolveSpecRequest reads legacy git_commit / content_hash frontmatter keys", async () => {
  // Existing backlog artifacts predate the canonical intent_commit / intent_hash
  // names; both spellings must reconcile against the same card.
  const legacy = intentMarkdown().replace("intent_commit:", "git_commit:").replace("intent_hash:", "content_hash:");
  const resolved = await resolveSpecRequest(card(description()), {
    ...baseOptions,
    fetchFn: stubFetch(legacy),
  });
  assert.equal(resolved.intentContentSha256, "d".repeat(64));
  assert.deepEqual(resolved.warnings, [], "matching legacy keys must not warn");
});

test("resolveSpecRequest still rejects a genuine hash disagreement under legacy keys", async () => {
  const legacy = intentMarkdown({ intent_hash: `sha256:${"e".repeat(64)}` })
    .replace("intent_commit:", "git_commit:")
    .replace("intent_hash:", "content_hash:");
  await assert.rejects(
    resolveSpecRequest(card(description()), { ...baseOptions, fetchFn: stubFetch(legacy) }),
    (err: Error) => err instanceof SpecRequestError && /intent_hash/.test(err.message),
  );
});

test("resolveSpecRequest proceeds for an intent that is not frozen", async () => {
  const resolved = await resolveSpecRequest(card(description({ "Intent Status": "New Ideas" })), {
    ...baseOptions,
    fetchFn: stubFetch(intentMarkdown({ status: "New Ideas" })),
  });
  assert.equal(resolved.intentId, "INT-MF-0042");
  assert.deepEqual(resolved.warnings, [], "agreeing on a non-frozen status is not worth a warning");
});

test("resolveSpecRequest warns, but does not fail, when card and backlog status disagree", async () => {
  const resolved = await resolveSpecRequest(card(description({ "Intent Status": "Frozen" })), {
    ...baseOptions,
    fetchFn: stubFetch(intentMarkdown({ status: "New Ideas" })),
  });
  assert.equal(resolved.intentId, "INT-MF-0042");
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /Intent Status "Frozen".*"New Ideas"/);
});

test("identity and hash disagreements are still hard failures", async () => {
  // Relaxing the freeze gate must not relax integrity.
  await assert.rejects(
    resolveSpecRequest(card(description()), {
      ...baseOptions,
      fetchFn: stubFetch(intentMarkdown({ intent_id: "INT-MF-9999" })),
    }),
    SpecRequestError,
  );
  await assert.rejects(
    resolveSpecRequest(card(description()), {
      ...baseOptions,
      fetchFn: stubFetch(intentMarkdown({ intent_hash: `sha256:${"e".repeat(64)}` })),
    }),
    SpecRequestError,
  );
});
