// ABOUTME: Verifies the Spec & Design Agent container handoff across a real spawned docker CLI process.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSpecDesignAgent, type SpecDesignRequest } from "./runSpecDesignAgent.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_DOCKER = join(here, "__fixtures__", "fake-docker.cjs");
const FAKE_LOCAL_AGENT = join(here, "__fixtures__", "fake-local-agent.cjs");

const FROZEN_INTENT = Buffer.from("---\nintent_id: INT-MF-0042\nstatus: Frozen\n---\n\n# Intent\n");
const FROZEN_PROFILE = Buffer.from("Profile ID: MF-DEFAULT\nVersion: 1\n");
const INVOCATION_ID = "invoke-integration-1";

function workspaceWithIntent(): { dir: string; targetRepo: string; sha: string; baseCommit: string } {
  const dir = mkdtempSync(join(tmpdir(), "spec-container-ws-"));
  const targetRepo = mkdtempSync(join(tmpdir(), "spec-container-target-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: targetRepo, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(targetRepo, "app.js"), "// product code\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  const baseCommit = git("rev-parse", "HEAD").toString().trim();
  mkdirSync(join(dir, ".agent", "inputs", INVOCATION_ID), { recursive: true });
  writeFileSync(join(dir, ".agent", "inputs", INVOCATION_ID, "intent.md"), FROZEN_INTENT);
  writeFileSync(join(dir, ".agent", "inputs", INVOCATION_ID, "policy-profile.md"), FROZEN_PROFILE);
  return { dir, targetRepo, sha: createHash("sha256").update(FROZEN_INTENT).digest("hex"), baseCommit };
}

function request(workspaceSha: string, baseCommit: string): SpecDesignRequest {
  return {
    requestVersion: 2,
    runId: "run-integration-1",
    invocationId: INVOCATION_ID,
    triggerEventId: "event-integration-1",
    stage: "spec_design",
    workItem: "INT-MF-0042",
    productId: "MF",
    intentContentSha256: "c".repeat(64),
    freezeActivation: {
      schema_version: "1.0",
      event_id: "freeze-integration-1",
      event_type: "activated",
      work_item: { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 5, trello_card_id: "card-123" },
      intent: {
        repository: "https://github.com/dbacks95fan/intent-backlog",
        commit_sha: "a".repeat(40),
        path: "products/mealflow/intents/INT-MF-0042/intent.md",
        sha256: workspaceSha,
      },
      policy_profile_id: "MF-DEFAULT",
      policy_profile_version: "1",
      policy_profile: {
        repository: "https://github.com/dbacks95fan/intent-backlog",
        commit_sha: "a".repeat(40),
        path: "products/mealflow/policy-profiles/default.md",
        sha256: createHash("sha256").update(FROZEN_PROFILE).digest("hex"),
      },
      authorized_by: "Sobe",
      recorded_at: "2026-09-06T09:00:00.000Z",
    },
    target: {
      repository: "https://github.com/example/mealflow",
      baseCommit,
      branch: "work/INT-MF-0042",
      workspace: "/work/repository",
    },
    readPaths: ["."],
    writePaths: [".agent/work/INT-MF-0042"],
  };
}

test("writes the request into the mount, runs the container, and parses the result", async () => {
  const { dir, targetRepo, sha, baseCommit } = workspaceWithIntent();
  const argvLog = join(mkdtempSync(join(tmpdir(), "spec-container-log-")), "argv.json");
  process.env.FAKE_DOCKER_ARGV_LOG = argvLog;
  process.env.FAKE_DOCKER_MODE = "spec_ready";
  process.env.FAKE_DOCKER_TARGET_REPO = targetRepo;

  try {
    const run = await runSpecDesignAgent(request(sha, baseCommit), {
      hostWorkspace: dir,
      docker: ["node", FAKE_DOCKER],
      image: "spec-design-agent:local",
      provider: "mock",
      envFile: null,
    });

    assert.equal(run.exitCode, 0, run.rawStdout + run.rawStderr);
    assert.equal(run.result?.status, "spec_ready");
    assert.equal(run.result?.specPath, ".agent/work/INT-MF-0042/spec.md");
    assert.match(String(run.result?.specCommit), /^[0-9a-f]{40}$/);

    // The agent saw the request through the bind mount, not a host path.
    const argv = JSON.parse(readFileSync(argvLog, "utf8")) as string[];
    assert.equal(argv[argv.indexOf("--request") + 1], "/work/spec-design-request.json");
    assert.equal(argv[argv.indexOf("--mount") + 1], `type=bind,source=${dir},target=/work`);
    assert.ok(argv.includes("SPEC_AGENT_PROVIDER=mock"));

    // The spec is committed on the work branch inside the mounted workspace.
    assert.ok(existsSync(join(dir, "repository", ".agent", "work", "INT-MF-0042", "spec.md")));
    // The transient request file is cleaned up afterwards.
    assert.ok(!existsSync(join(dir, "spec-design-request.json")));
  } finally {
    delete process.env.FAKE_DOCKER_ARGV_LOG;
    delete process.env.FAKE_DOCKER_MODE;
    delete process.env.FAKE_DOCKER_TARGET_REPO;
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dirname(argvLog), { recursive: true, force: true });
  }
});

test("surfaces a container crash as an unparseable result", async () => {
  const { dir, targetRepo, sha, baseCommit } = workspaceWithIntent();
  process.env.FAKE_DOCKER_MODE = "garbage";
  process.env.FAKE_DOCKER_TARGET_REPO = targetRepo;
  try {
    const run = await runSpecDesignAgent(request(sha, baseCommit), {
      hostWorkspace: dir,
      docker: ["node", FAKE_DOCKER],
      provider: "mock",
      envFile: null,
    });
    assert.equal(run.exitCode, 30);
    assert.equal(run.result, null);
    assert.match(run.rawStderr, /provider exploded/);
  } finally {
    delete process.env.FAKE_DOCKER_MODE;
    delete process.env.FAKE_DOCKER_TARGET_REPO;
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  }
});

test("reports a mutated frozen intent as blocked", async () => {
  const { dir, targetRepo, baseCommit } = workspaceWithIntent();
  process.env.FAKE_DOCKER_MODE = "spec_ready";
  process.env.FAKE_DOCKER_TARGET_REPO = targetRepo;
  try {
    const run = await runSpecDesignAgent(request("f".repeat(64), baseCommit), {
      hostWorkspace: dir,
      docker: ["node", FAKE_DOCKER],
      provider: "mock",
      envFile: null,
    });
    assert.equal(run.result?.status, "blocked");
    assert.deepEqual(run.result?.blockingConcerns, ["INTENT_MUTATED"]);
  } finally {
    delete process.env.FAKE_DOCKER_MODE;
    delete process.env.FAKE_DOCKER_TARGET_REPO;
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  }
});

test("kills the container and reports a timeout when it overruns its budget", async () => {
  const { dir, targetRepo, sha, baseCommit } = workspaceWithIntent();
  process.env.FAKE_DOCKER_MODE = "hang";
  process.env.FAKE_DOCKER_TARGET_REPO = targetRepo;
  try {
    const run = await runSpecDesignAgent(request(sha, baseCommit), {
      hostWorkspace: dir,
      docker: ["node", FAKE_DOCKER],
      provider: "mock",
      envFile: null,
      timeoutMs: 300,
    });
    assert.equal(run.timedOut, true);
    assert.equal(run.result, null);
  } finally {
    delete process.env.FAKE_DOCKER_MODE;
    delete process.env.FAKE_DOCKER_TARGET_REPO;
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  }
});

test("reports a missing docker binary instead of throwing", async () => {
  const { dir, targetRepo, sha, baseCommit } = workspaceWithIntent();
  try {
    const run = await runSpecDesignAgent(request(sha, baseCommit), {
      hostWorkspace: dir,
      docker: ["this-docker-does-not-exist-9f3a"],
      provider: "mock",
      envFile: null,
    });
    assert.equal(run.result, null);
    assert.equal(run.timedOut, false);
    assert.match(run.rawStderr, /ENOENT|spawn/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  }
});

test("runs the local CLI with the request and selected provider, then removes the transient request", async () => {
  const { dir, targetRepo, sha, baseCommit } = workspaceWithIntent();
  const logPath = join(dir, "local-run.json");
  process.env.FAKE_LOCAL_SPEC_LOG = logPath;
  try {
    const run = await runSpecDesignAgent(request(sha, baseCommit), {
      hostWorkspace: dir,
      runtime: "local",
      localCommand: [process.execPath, FAKE_LOCAL_AGENT],
      agentDirectory: dir,
      provider: "codex",
    });
    assert.equal(run.exitCode, 0, run.rawStdout + run.rawStderr);
    assert.equal(run.result?.status, "spec_ready");
    const logged = JSON.parse(readFileSync(logPath, "utf8")) as {
      args: string[];
      request: SpecDesignRequest;
      provider: string;
      cwd: string;
    };
    assert.equal(logged.provider, "codex");
    assert.equal(logged.cwd, dir);
    assert.equal(logged.args[logged.args.indexOf("--provider") + 1], "codex");
    assert.equal(logged.request.workItem, "INT-MF-0042");
    assert.ok(!existsSync(join(dir, "spec-design-request.json")));
  } finally {
    delete process.env.FAKE_LOCAL_SPEC_LOG;
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  }
});
