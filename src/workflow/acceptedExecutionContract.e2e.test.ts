// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Exercises frozen acceptance through canonical v3 validation and StageInvocation construction.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const intentHashProjection = "d".repeat(64);
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

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
}

test("loads accepted immutable artifacts and adapts them against the accepted work branch", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "accepted-execution-e2e-"));
  const repositoryPath = join(workspaceRoot, intentId);
  mkdirSync(repositoryPath, { recursive: true });
  try {
    git(repositoryPath, "init", "-b", "main");
    git(repositoryPath, "config", "user.email", "test@example.com");
    git(repositoryPath, "config", "user.name", "Test");
    writeFileSync(join(repositoryPath, "app.js"), "// baseline\n");
    git(repositoryPath, "add", "-A");
    git(repositoryPath, "commit", "-m", "baseline");
    const baseCommit = git(repositoryPath, "rev-parse", "HEAD");
    git(repositoryPath, "remote", "add", "origin", `${productUrl}.git`);
    const workspaceRef = `work/${intentId}`;
    git(repositoryPath, "checkout", "-b", workspaceRef);

    const intentPath = `.agent/work/${intentId}/intent.md`;
    mkdirSync(join(repositoryPath, `.agent/work/${intentId}`), { recursive: true });
    writeFileSync(join(repositoryPath, intentPath), frozenIntent);
    git(repositoryPath, "add", intentPath);
    git(repositoryPath, "commit", "-m", "freeze intent");

    const workContractV3 = {
      schema_version: 3,
      work_item: { product_id: "MF", intent_id: intentId, intent_version: 3, trello_card_id: "card-1" },
      intent: {
        repository: backlogUrl,
        commit_sha: intentCommit,
        path: `products/mealflow/intents/${intentId}/intent.md`,
        sha256: digest(frozenIntent),
      },
      policy_profile_id: "MF-DEFAULT",
      policy_profile_version: "1",
      policy_profile: {
        repository: backlogUrl,
        commit_sha: intentCommit,
        path: "products/mealflow/policy-profiles/default.md",
        sha256: digest(profile),
      },
      target: { repository: productUrl, commit_sha: baseCommit },
      acceptance_criteria: ["The person can plan the week.", "The plan can be saved."],
      permitted_scope: { included: ["Weekly planning"], excluded: ["Export"] },
      required_validation: [{ name: "build", command: "npm run build" }],
      policy_controls: [],
      release_requirements: [],
      observation_requirements: [],
    };
    const contractText = JSON.stringify(workContractV3);
    const workContractPath = `.agent/work/${intentId}/work-contract.yaml`;
    const specPath = `.agent/work/${intentId}/spec.md`;
    writeFileSync(join(repositoryPath, workContractPath), contractText);
    writeFileSync(join(repositoryPath, specPath), specText);
    git(repositoryPath, "add", workContractPath, specPath);
    git(repositoryPath, "commit", "-m", "spec and work contract");
    const artifactCommit = git(repositoryPath, "rev-parse", "HEAD");

    const record = {
      schema_version: "1.0",
      work_item: { product_id: "MF", intent_id: intentId, intent_version: 3, trello_card_id: "card-1" },
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
        `Canonical intent: ${backlogUrl}/blob/${intentCommit}/products/mealflow/intents/${intentId}/intent.md`,
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
    const yaml = (value: string) => value;
    const productYaml = yaml(
      `schema_version: "1.1"\nproduct_id: MF\nproduct_name: MealFlow\ntrello_board_id: board-1\ntrello_lists:\n  new_ideas: list-new\n  backlog: list-backlog\n  prioritized: list-prioritized\n  spec_design: list-spec\n  execution: list-execution\n  evaluation: list-evaluation\n  human_approval: list-human-approval\n  release: list-release\n  production_observation: list-observation\n  done: list-done\ntarget_repository: ${productUrl}\nauthorized_product_owner_ids:\n  - owner-1\npolicy_profiles:\n  MF-DEFAULT: policy-profiles/default.md\n`,
    );
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("product.yaml?")) return new Response(productYaml);
      if (url.includes("default.md?")) return new Response(profile);
      if (url.includes("intent.md?")) return new Response(frozenIntent);
      if (url.includes("spec.md?")) return new Response(specText);
      if (url.includes("work-contract.yaml?")) return new Response(contractText);
      return new Response("Not Found", { status: 404 });
    };

    const freezeActivation = {
      schema_version: "1.0",
      event_id: "freeze-event-1",
      event_type: "activated",
      work_item: { product_id: "MF", intent_id: intentId, intent_version: 3, trello_card_id: "card-1" },
      intent: {
        repository: backlogUrl,
        commit_sha: intentCommit,
        path: `products/mealflow/intents/${intentId}/intent.md`,
        sha256: digest(frozenIntent),
      },
      policy_profile_id: "MF-DEFAULT",
      policy_profile_version: "1",
      policy_profile: {
        repository: backlogUrl,
        commit_sha: intentCommit,
        path: "products/mealflow/policy-profiles/default.md",
        sha256: digest(profile),
      },
      authorized_by: "owner-1",
      recorded_at: "2026-10-27T11:00:00.000Z",
    };
    const result = await loadAcceptedExecutionContract({
      card,
      acceptance: record,
      workspaceRef,
      targetCommit: baseCommit,
      workspaceRoot,
      intentBacklogApiBase: "https://api.github.com",
      intentBacklogReadToken: "",
      createProductRepositoryReadToken: async () => "test-product-read-token",
      validator: createLifecycleValidator(config.lifecycleSchemaPath),
      freezeActivation,
      fetchFn,
      targetRepositoryUrl: productUrl,
    });
    assert.equal(result.workContract.schema_version, 2);
    assert.equal(result.workContract.work_item, `${intentId}-v3`);
    assert.equal(result.workContract.objective, "A person can create a weekly meal plan.");
    assert.equal(result.repositoryPath, repositoryPath);
    assert.equal(result.baseBranch, workspaceRef);
    assert.equal(result.invocation.schema_version, "1.1");
    assert.equal(result.invocation.stage, "execution");
    assert.equal((result.invocation.target as Record<string, unknown>).commit_sha, artifactCommit);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
