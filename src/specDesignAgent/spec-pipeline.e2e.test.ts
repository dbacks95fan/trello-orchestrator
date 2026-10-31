// ABOUTME: End-to-end test of the Spec & Design pipeline: card -> frozen intent -> clone -> container -> routing.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSpecRequest } from "../workflow/specRequestFromCard.js";
import { prepareSpecWorkspace } from "../workflow/specWorkspace.js";
import { routeSpecResult } from "../workflow/specRouting.js";
import { CONTAINER_WORKSPACE, runSpecDesignAgent, type SpecDesignRequest } from "./runSpecDesignAgent.js";
import type { TrelloCard } from "../trello/client.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_DOCKER = join(here, "__fixtures__", "fake-docker.cjs");

const PATH = "products/mealflow/intents/INT-MF-0042/intent.md";
const COMMIT = "a".repeat(40);
const HASH = "d".repeat(64);
const PROFILE = "Profile ID: MF-DEFAULT\nVersion: 1\n";

function initTargetRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-e2e-target-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  // A compliant product repo: agent scratch ignored, `.agent/work/` tracked.
  writeFileSync(join(dir, ".gitignore"), ".agent/*\n!.agent/work/\n");
  writeFileSync(join(dir, "app.js"), "// product code\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  // Never contacted in this test; origin only has to be a valid HTTPS remote so
  // the workspace can be retargeted at something the container could reach.
  git("remote", "add", "origin", "https://github.com/example/mealflow.git");
  return dir;
}

function intentMarkdown(): string {
  return [
    "---",
    "intent_id: INT-MF-0042",
    "product_id: MF",
    "product_name: MealFlow",
    "trello_card_id: card-long-id",
    "intent_version: 3",
    "status: Frozen",
    `intent_commit: ${COMMIT}`,
    `intent_hash: sha256:${HASH}`,
    "policy_profile_id: MF-DEFAULT",
    "policy_profile_version: 1",
    "frozen_at: 2026-08-01T12:00:00.000Z",
    "---",
    "",
    "# Intent: Weekly meal planner",
    "",
    "## Desired outcome",
    "A cook plans a week of meals in one sitting.",
  ].join("\n");
}

function card(): TrelloCard {
  return {
    id: "card-long-id",
    idShort: 42,
    name: "[Feature] Weekly meal planner",
    desc: [
      "Product: MealFlow (MF)",
      "Intent ID: INT-MF-0042",
      "Intent Version: 3",
      `Intent Commit: ${COMMIT}`,
      `Intent Hash: sha256:${HASH}`,
      "Intent Status: Frozen",
      "Policy Profile ID: MF-DEFAULT",
      "Policy Profile Version: 1",
      `Canonical intent: https://github.com/dbacks95fan/intent-backlog/blob/${COMMIT}/${PATH}`,
    ].join("\n"),
    idList: "list-spec",
    shortLink: "abc123",
    url: "https://trello.com/c/abc123/42",
  };
}

async function runPipeline(targetRepo: string, workspaceRoot: string) {
  process.env.FAKE_DOCKER_TARGET_REPO = targetRepo;
  const resolved = await resolveSpecRequest(card(), {
    githubApiBase: "https://api.github.com",
    intentBacklogReadToken: "",
    approvedBy: "Sobe",
    approvedAt: "2026-09-06T09:00:00.000Z",
    targetRepositoryUrl: "https://github.com/example/mealflow",
    fetchFn: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/product.yaml?"))
        return new Response(
          'schema_version: "1.1"\nproduct_id: MF\nproduct_name: MealFlow\ntrello_board_id: board-1\ntrello_lists:\n  new_ideas: list-new\n  backlog: list-backlog\n  prioritized: list-prioritized\n  spec_design: list-spec\n  execution: list-execution\n  evaluation: list-evaluation\n  human_approval: list-human-approval\n  release: list-release\n  production_observation: list-observation\n  done: list-done\ntarget_repository: https://github.com/example/mealflow\nauthorized_product_owner_ids:\n  - owner-1\npolicy_profiles:\n  MF-DEFAULT: policy-profiles/default.md\n',
        );
      if (url.includes("/policy-profiles/default.md?")) return new Response(PROFILE);
      return new Response(intentMarkdown());
    }) as typeof fetch,
  });

  const workspace = await prepareSpecWorkspace({
    targetRepository: "https://github.com/example/mealflow",
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRepo }).toString().trim(),
    workspaceRoot,
    intentId: resolved.intentId,
    invocationId: "e2e-invocation-1",
    frozenIntentBytes: resolved.frozenIntentBytes,
    frozenPolicyProfileBytes: resolved.frozenPolicyProfileBytes,
  });

  const request: SpecDesignRequest = {
    requestVersion: 2,
    runId: "e2e-run-1",
    invocationId: "e2e-invocation-1",
    triggerEventId: "board-event-1",
    stage: "spec_design",
    workItem: resolved.intentId,
    productId: resolved.productId,
    intentContentSha256: resolved.intentContentSha256,
    freezeActivation: {
      schema_version: "1.0",
      event_id: "freeze-event-1",
      event_type: "activated",
      work_item: {
        product_id: resolved.productId,
        intent_id: resolved.intentId,
        intent_version: resolved.intentVersion,
        trello_card_id: "card-long-id",
      },
      intent: {
        repository: `https://github.com/${resolved.intentRepository}`,
        commit_sha: resolved.intentCommit,
        path: resolved.intentPath,
        sha256: workspace.frozenArtifactSha256,
      },
      policy_profile_id: resolved.policyProfileId,
      policy_profile_version: resolved.policyProfileVersion,
      policy_profile: {
        repository: `https://github.com/${resolved.intentRepository}`,
        commit_sha: resolved.intentCommit,
        path: resolved.policyProfilePath,
        sha256: resolved.policyProfileContentSha256,
      },
      authorized_by: resolved.approvedBy,
      recorded_at: resolved.approvedAt,
    },
    target: {
      repository: workspace.remoteUrl,
      baseCommit: workspace.baseCommit,
      branch: workspace.branch,
      workspace: `${CONTAINER_WORKSPACE}/repository`,
    },
    readPaths: ["."],
    writePaths: [`.agent/work/${resolved.intentId}`],
  };

  const run = await runSpecDesignAgent(request, {
    hostWorkspace: workspace.path,
    docker: ["node", FAKE_DOCKER],
    image: "spec-design-agent:local",
    provider: "mock",
    envFile: null,
  });

  return { workspace, run, route: routeSpecResult(run) };
}

test("card -> frozen intent/profile -> clone -> container -> human review", async () => {
  const targetRepo = initTargetRepo();
  const workspaceRoot = mkdtempSync(join(tmpdir(), "spec-e2e-roots-"));
  process.env.FAKE_DOCKER_MODE = "spec_ready";

  try {
    const { workspace, run, route } = await runPipeline(targetRepo, workspaceRoot);

    assert.equal(run.result?.status, "spec_ready", run.rawStdout + run.rawStderr);
    assert.equal(route.destination, null);
    assert.match(route.comment, /remains in Spec & Design/);
    assert.match(route.comment, /\.agent\/work\/INT-MF-0042\/spec\.md/);

    assert.ok(existsSync(join(workspace.repositoryPath, ".agent", "work", "INT-MF-0042", "spec.md")));
    const log = execFileSync("git", ["log", "--oneline"], { cwd: workspace.repositoryPath })
      .toString()
      .trim()
      .split("\n");
    assert.match(log[0], /spec: INT-MF-0042/);
    assert.match(log[1], /initial/);
    assert.equal(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace.repositoryPath }).toString().trim(),
      "work/INT-MF-0042",
    );
    // The product repository itself is untouched by the Spec & Design stage.
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: targetRepo }).toString().trim(), "");
  } finally {
    delete process.env.FAKE_DOCKER_MODE;
    delete process.env.FAKE_DOCKER_TARGET_REPO;
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("card -> frozen intent/profile -> clone -> container -> human decision in Spec & Design", async () => {
  const targetRepo = initTargetRepo();
  const workspaceRoot = mkdtempSync(join(tmpdir(), "spec-e2e-roots-"));
  process.env.FAKE_DOCKER_MODE = "needs_decision";

  try {
    const { workspace, run, route } = await runPipeline(targetRepo, workspaceRoot);

    assert.equal(run.exitCode, 10);
    assert.equal(route.destination, null);
    assert.match(route.comment, /Which service owns meal-plan persistence\?/);
    assert.match(route.comment, /Product engineering lead/);
    // No spec is committed when a decision is outstanding.
    assert.ok(!existsSync(join(workspace.repositoryPath, ".agent", "work", "INT-MF-0042", "spec.md")));
  } finally {
    delete process.env.FAKE_DOCKER_MODE;
    delete process.env.FAKE_DOCKER_TARGET_REPO;
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
