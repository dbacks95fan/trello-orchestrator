// ABOUTME: Tests that the Spec & Design workspace stages exact frozen inputs per invocation.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSpecWorkspace, verifySpecBranchPublished } from "./specWorkspace.js";

const REMOTE_URL = "https://github.com/example/target.git";
const FROZEN_PROFILE = Buffer.from("Profile ID: MF-DEFAULT\nVersion: 1\n");

function initRepo(originUrl: string | null = REMOTE_URL): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-workspace-target-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  // A compliant product repo: agent scratch is ignored, `.agent/work/` is tracked
  // so every stage can commit its artifacts with a plain `git add`.
  writeFileSync(join(dir, ".gitignore"), ".agent/*\n!.agent/work/\n");
  writeFileSync(join(dir, "README.md"), "target repo\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  // Never contacted: the clone is made from the local path, and origin is only
  // retargeted so the container and the push step have a reachable remote.
  if (originUrl) git("remote", "add", "origin", originUrl);
  return dir;
}

test("prepareSpecWorkspace stages exact snapshots without creating or publishing a Git branch", async () => {
  const targetRepo = initRepo();
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRepo }).toString().trim();
  const workspaceRoot = mkdtempSync(join(tmpdir(), "spec-workspace-roots-"));
  const frozenIntentBytes = Buffer.from("---\nintent_id: INT-MF-0042\nstatus: Frozen\n---\n\n# Intent\n");
  const intentId = "INT-MF-0042";

  try {
    const invocationId = "invocation-1";
    const first = await prepareSpecWorkspace({
      targetRepository: REMOTE_URL,
      baseCommit,
      workspaceRoot,
      intentId,
      invocationId,
      frozenIntentBytes,
      frozenPolicyProfileBytes: FROZEN_PROFILE,
    });

    assert.equal(first.created, true);
    assert.equal(first.branch, "work/INT-MF-0042");
    assert.equal(first.baseCommit, baseCommit);
    assert.equal(first.frozenArtifactSha256, createHash("sha256").update(frozenIntentBytes).digest("hex"));

    assert.equal(existsSync(join(first.path, ".git")), false, "the Orchestrator must not create a Git repository");
    assert.equal(existsSync(first.repositoryPath), false, "the agent creates the product clone");

    const intentFile = join(first.path, ".agent", "inputs", invocationId, "intent.md");
    assert.ok(existsSync(intentFile));
    assert.deepEqual(readFileSync(intentFile), frozenIntentBytes);
    assert.deepEqual(
      readFileSync(join(first.path, ".agent", "inputs", invocationId, "policy-profile.md")),
      FROZEN_PROFILE,
    );

    assert.equal(first.remoteUrl, REMOTE_URL.replace(/\.git$/, ""));

    const second = await prepareSpecWorkspace({
      targetRepository: REMOTE_URL,
      baseCommit,
      workspaceRoot,
      intentId,
      invocationId,
      frozenIntentBytes,
      frozenPolicyProfileBytes: FROZEN_PROFILE,
    });
    assert.equal(second.created, false);
    assert.equal(second.path, first.path);
    assert.equal(existsSync(join(second.path, ".git")), false);
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("prepareSpecWorkspace stages invocation inputs when the repo ignores .agent/", async () => {
  const targetRepo = initRepo();
  // Invocation inputs are transient and can be staged even when .agent/ is ignored.
  writeFileSync(join(targetRepo, ".gitignore"), ".agent/\n");
  execFileSync("git", ["commit", "-qam", "ignore .agent"], { cwd: targetRepo, stdio: "pipe" });
  const workspaceRoot = mkdtempSync(join(tmpdir(), "spec-workspace-roots-"));
  try {
    const workspace = await prepareSpecWorkspace({
      targetRepository: REMOTE_URL,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRepo }).toString().trim(),
      workspaceRoot,
      intentId: "INT-MF-0042",
      invocationId: "invocation-ignored-agent-dir",
      frozenIntentBytes: Buffer.from("---\nintent_id: INT-MF-0042\n---\n"),
      frozenPolicyProfileBytes: FROZEN_PROFILE,
    });
    assert.deepEqual(
      readFileSync(join(workspace.path, ".agent", "inputs", "invocation-ignored-agent-dir", "intent.md")),
      Buffer.from("---\nintent_id: INT-MF-0042\n---\n"),
    );
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("prepareSpecWorkspace refuses a target repo without an HTTPS URL", async () => {
  const targetRepo = initRepo(null);
  const workspaceRoot = mkdtempSync(join(tmpdir(), "spec-workspace-roots-"));
  try {
    await assert.rejects(
      prepareSpecWorkspace({
        targetRepository: "file:///local/target.git",
        baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRepo }).toString().trim(),
        workspaceRoot,
        intentId: "INT-MF-0042",
        invocationId: "invocation-no-remote",
        frozenIntentBytes: Buffer.from("x"),
        frozenPolicyProfileBytes: FROZEN_PROFILE,
      }),
      /must be an HTTPS GitHub URL/,
    );
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("verifySpecBranchPublished observes the agent-pushed branch without writing refs", async () => {
  const bare = mkdtempSync(join(tmpdir(), "spec-remote-"));
  const clone = mkdtempSync(join(tmpdir(), "spec-clone-"));
  try {
    execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" });
    execFileSync("git", ["clone", "-q", bare, join(clone, "w")], { stdio: "pipe" });
    const work = join(clone, "w");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "pipe" });
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("checkout", "-qb", "work/INT-MF-0042");
    writeFileSync(join(work, "spec.md"), "spec\n");
    git("add", "-A");
    git("commit", "-qm", "spec");
    git("push", "--set-upstream", "origin", "work/INT-MF-0042");

    const result = await verifySpecBranchPublished({ path: work, branch: "work/INT-MF-0042", remoteUrl: bare }, "");

    assert.equal(result.pushed, true, String(result.reason ?? ""));
    assert.equal(result.branchUrl, `${bare}/tree/work/INT-MF-0042`);
    // The branch really landed on the remote.
    assert.match(
      execFileSync("git", ["--git-dir", bare, "branch", "--list", "work/INT-MF-0042"]).toString(),
      /work\/INT-MF-0042/,
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("verifySpecBranchPublished reports when the agent branch is absent", async () => {
  const result = await verifySpecBranchPublished(
    { path: tmpdir(), branch: "work/INT-MF-0042", remoteUrl: "https://github.com/example/target.git" },
    "",
  );
  assert.equal(result.pushed, false);
  assert.ok(result.reason);
  assert.equal(result.branchUrl, "https://github.com/example/target/tree/work/INT-MF-0042");
});
