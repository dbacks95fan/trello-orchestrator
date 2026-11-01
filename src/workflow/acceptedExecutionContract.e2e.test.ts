// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Exercises frozen acceptance through canonical v3 validation and StageInvocation construction.
// ABOUTME: Product files come from a stand-in GitHub API; no local workspace exists, as on a real Execution run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { config } from "../config.js";
import type { TrelloCard } from "../trello/client.js";
import { writeFreezeProjection } from "./freezeState.js";
import { loadAcceptedExecutionContract } from "./acceptedExecutionContract.js";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const intentId = "INT-MF-0042";
const productUrl = "https://github.com/example/mealflow";
const backlogUrl = "https://github.com/example/intent-backlog";
const intentCommit = "a".repeat(40);
const baseCommit = "b".repeat(40);
const artifactCommit = "c".repeat(40);
const intentHashProjection = "d".repeat(64);
const workspaceRef = `work/${intentId}`;
const profile = "Profile ID: MF-DEFAULT\nVersion: 1\n";
const frozenIntent = Buffer.from(
  [
    "---",
    `intent_id: ${intentId}`,
    "product_id: MF",
    "intent_version: 3",
    `intent_hash: sha256:${intentHashProjection}`,
    "policy_profile_id: MF-DEFAULT",
    "policy_profile_version: 1",
    "status: Frozen",
    "---",
    "",
    "# Meal planning intent",
    "",
  ].join("\n"),
);
const specText =
  "# Spec\n\n## Outcome and scope\nA person can create a weekly meal plan.\n\n## Acceptance criteria\n- The plan can be saved.\n";
const intentPath = `.agent/work/${intentId}/intent.md`;
const specPath = `.agent/work/${intentId}/spec.md`;
const workContractPath = `.agent/work/${intentId}/work-contract.yaml`;
const backlogIntentPath = `products/mealflow/intents/${intentId}/intent.md`;
const profilePath = "products/mealflow/policy-profiles/default.md";

const workItem = { product_id: "MF", intent_id: intentId, intent_version: 3, trello_card_id: "card-1" };
const intentRef = {
  repository: backlogUrl,
  commit_sha: intentCommit,
  path: backlogIntentPath,
  sha256: digest(frozenIntent),
};
const profileRef = { repository: backlogUrl, commit_sha: intentCommit, path: profilePath, sha256: digest(profile) };
const contractText = JSON.stringify({
  schema_version: 3,
  work_item: workItem,
  intent: intentRef,
  policy_profile_id: "MF-DEFAULT",
  policy_profile_version: "1",
  policy_profile: profileRef,
  target: { repository: productUrl, commit_sha: baseCommit },
  acceptance_criteria: ["The person can plan the week.", "The plan can be saved."],
  permitted_scope: { included: ["Weekly planning"], excluded: ["Export"] },
  required_validation: [{ name: "build", command: "npm run build" }],
  policy_controls: [],
  release_requirements: [],
  observation_requirements: [],
});
const record = {
  schema_version: "1.0",
  work_item: workItem,
  decision: "accepted_for_execution",
  authorized_by: "owner-1",
  recorded_at: "2026-10-27T12:00:00.000Z",
  spec: { repository: productUrl, commit_sha: artifactCommit, path: specPath, sha256: digest(specText) },
  work_contract: {
    repository: productUrl,
    commit_sha: artifactCommit,
    path: workContractPath,
    sha256: digest(contractText),
  },
};
const freezeActivation = {
  schema_version: "1.0",
  event_id: "freeze-event-1",
  event_type: "activated",
  work_item: workItem,
  intent: intentRef,
  policy_profile_id: "MF-DEFAULT",
  policy_profile_version: "1",
  policy_profile: profileRef,
  authorized_by: "owner-1",
  recorded_at: "2026-10-27T11:00:00.000Z",
};
const productYaml = `schema_version: "1.1"\nproduct_id: MF\nproduct_name: MealFlow\ntrello_board_id: board-1\ntrello_lists:\n  new_ideas: list-new\n  backlog: list-backlog\n  prioritized: list-prioritized\n  spec_design: list-spec\n  execution: list-execution\n  evaluation: list-evaluation\n  human_approval: list-human-approval\n  release: list-release\n  production_observation: list-observation\n  done: list-done\ntarget_repository: ${productUrl}\nauthorized_product_owner_ids:\n  - owner-1\npolicy_profiles:\n  MF-DEFAULT: policy-profiles/default.md\n`;

function acceptedCard(): TrelloCard {
  const card: TrelloCard = {
    id: "card-1",
    idBoard: "board-1",
    idShort: 1,
    name: "[Feature] Weekly plan",
    desc: [
      "Product: MealFlow (MF)",
      `Intent ID: ${intentId}`,
      "Intent Version: 3",
      `Intent Commit: ${intentCommit}`,
      `Intent Hash: sha256:${intentHashProjection}`,
      "Policy Profile ID: MF-DEFAULT",
      "Policy Profile Version: 1",
      `Canonical intent: ${backlogUrl}/blob/${intentCommit}/${backlogIntentPath}`,
    ].join("\n"),
    idList: "execution",
    shortLink: "abc",
    url: "https://trello.com/c/abc",
  };
  card.desc = writeFreezeProjection(card.desc, {
    state: "Active",
    tuple: {
      productId: "MF",
      intentId,
      intentVersion: 3,
      intentCommit,
      intentSha256: digest(frozenIntent),
      policyProfileId: "MF-DEFAULT",
      policyProfileVersion: "1",
      policyProfileCommit: intentCommit,
      policyProfileSha256: digest(profile),
      cardId: card.id,
      freezeEventId: "freeze-event-1",
      authorizedBy: "owner-1",
      frozenAt: "2026-10-27T11:00:00.000Z",
    },
  });
  return card;
}

interface FakeGitHub {
  branchTip?: string;
  branchCopyOfIntent?: Buffer;
  requested: string[];
}

/** Serves the intent backlog and the product repository the way GitHub's REST API does. */
function fakeGitHub(state: FakeGitHub): typeof fetch {
  const productFiles: Record<string, Buffer> = {
    [specPath]: Buffer.from(specText),
    [workContractPath]: Buffer.from(contractText),
    [intentPath]: state.branchCopyOfIntent ?? frozenIntent,
  };
  return async (input) => {
    const url = String(input);
    state.requested.push(url);
    if (url.endsWith(`/repos/example/mealflow/git/ref/heads/work/${intentId}`))
      return Response.json({ object: { sha: state.branchTip ?? artifactCommit, type: "commit" } });
    const product = url.match(/\/repos\/example\/mealflow\/contents\/(.+)\?ref=([0-9a-f]+)$/);
    if (product) {
      const path = product[1].split("/").map(decodeURIComponent).join("/");
      const body = product[2] === artifactCommit ? productFiles[path] : undefined;
      return body === undefined ? new Response("Not Found", { status: 404 }) : new Response(new Uint8Array(body));
    }
    if (url.includes("product.yaml?")) return new Response(productYaml);
    if (url.includes("default.md?")) return new Response(profile);
    if (url.includes(`intent-backlog/contents/${backlogIntentPath.split("/").map(encodeURIComponent).join("/")}?`))
      return new Response(frozenIntent);
    return new Response("Not Found", { status: 404 });
  };
}

function load(fetchFn: typeof fetch) {
  return loadAcceptedExecutionContract({
    card: acceptedCard(),
    acceptance: record,
    workspaceRef,
    targetCommit: baseCommit,
    intentBacklogApiBase: "https://api.github.com",
    intentBacklogReadToken: "",
    createProductRepositoryReadToken: async () => "test-product-read-token",
    validator: createLifecycleValidator(config.lifecycleSchemaPath),
    freezeActivation,
    fetchFn,
    targetRepositoryUrl: productUrl,
  });
}

test("loads accepted artifacts from GitHub at the accepted commit, with no local workspace", async () => {
  const state: FakeGitHub = { requested: [] };
  const result = await load(fakeGitHub(state));
  assert.equal(result.workContract.schema_version, 2);
  assert.equal(result.workContract.work_item, `${intentId}-v3`);
  assert.equal(result.workContract.objective, "A person can create a weekly meal plan.");
  assert.equal(result.baseBranch, workspaceRef);
  assert.equal(result.invocation.schema_version, "1.1");
  assert.equal(result.invocation.stage, "execution");
  assert.equal((result.invocation.target as Record<string, unknown>).commit_sha, artifactCommit);
  assert.ok(
    state.requested.some((url) => url.endsWith(`/contents/${intentPath}?ref=${artifactCommit}`)),
    "the frozen intent copy is read at the accepted commit",
  );
});

test("a work branch that moved after acceptance is refused", async () => {
  await assert.rejects(
    load(fakeGitHub({ branchTip: "e".repeat(40), requested: [] })),
    /branch moved after the human accepted its artifacts/,
  );
});

test("a frozen intent copy on the branch that differs by line endings is refused", async () => {
  const converted = Buffer.from(frozenIntent.toString("utf8").replace(/\n/g, "\r\n"));
  await assert.rejects(
    load(fakeGitHub({ branchCopyOfIntent: converted, requested: [] })),
    /frozen intent copy on the work branch has changed/,
  );
});
