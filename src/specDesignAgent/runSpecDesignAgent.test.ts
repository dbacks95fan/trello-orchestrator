// ABOUTME: Unit tests for the docker run argv and result parsing of the Spec & Design Agent container.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDockerArgs,
  parseAgentResult,
  CONTAINER_CHECK_MANIFEST,
  CONTAINER_WORKSPACE,
} from "./runSpecDesignAgent.js";

test("buildDockerArgs bind-mounts the workspace and mirrors the compose hardening", () => {
  const args = buildDockerArgs({
    docker: ["docker"],
    image: "spec-design-agent:local",
    hostWorkspace: "C:\\Repos\\agentic-sdlc-workspaces\\INT-MF-0042",
    inputSnapshotPath: "C:\\Repos\\agentic-sdlc-workspaces\\INT-MF-0042\\.agent\\inputs\\invoke-1",
    invocationId: "invoke-1",
    provider: "claude",
    envFile: "C:\\Repos\\.config\\spec-design-agent\\runtime.env",
    containerName: "spec-design-run-1",
  });

  assert.equal(args[0], "run");
  assert.ok(args.includes("--rm"));
  assert.equal(
    args[args.indexOf("--mount") + 1],
    `type=bind,source=C:\\Repos\\agentic-sdlc-workspaces\\INT-MF-0042,target=${CONTAINER_WORKSPACE}`,
  );
  const inputMountIndex = args.indexOf("--mount", args.indexOf("--mount") + 1);
  assert.equal(
    args[inputMountIndex + 1],
    "type=bind,source=C:\\Repos\\agentic-sdlc-workspaces\\INT-MF-0042\\.agent\\inputs\\invoke-1,target=/work/.agent/inputs/invoke-1,readonly",
  );
  assert.ok(args.includes("--read-only"));
  assert.equal(args[args.indexOf("--tmpfs") + 1], "/tmp");
  assert.ok(args.includes("HOME=/tmp"));
  assert.ok(args.includes("SPEC_AGENT_PROVIDER=claude"));
  // Without safe.directory git refuses the bind-mounted repo as a non-root uid.
  assert.ok(args.includes("GIT_CONFIG_COUNT=3"));
  assert.ok(args.includes("GIT_CONFIG_KEY_0=safe.directory"));
  assert.ok(args.includes(`GIT_CONFIG_VALUE_0=${CONTAINER_WORKSPACE}`));
  assert.ok(args.includes("GIT_CONFIG_KEY_1=user.email"));
  assert.ok(args.includes("GIT_CONFIG_KEY_2=user.name"));
  assert.equal(args[args.indexOf("--security-opt") + 1], "no-new-privileges:true");
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(args[args.indexOf("--env-file") + 1], "C:\\Repos\\.config\\spec-design-agent\\runtime.env");
  assert.equal(args[args.indexOf("--name") + 1], "spec-design-run-1");
  // The image must be the last element: the CLI subcommand is appended after it.
  assert.equal(args[args.length - 1], "spec-design-agent:local");
});

test("buildDockerArgs does not read or inject agent credentials", () => {
  const args = buildDockerArgs({
    docker: ["docker"],
    image: "img",
    hostWorkspace: "/ws",
    provider: "mock",
  });
  assert.ok(!args.includes("--env-file"));
  assert.ok(!args.includes("--name"));
  assert.ok(args.includes("GIT_CONFIG_COUNT=3"));
  assert.ok(!args.includes("SPEC_AGENT_GITHUB_TOKEN"));
  assert.equal(args[args.length - 1], "img");
});

test("buildDockerArgs mounts the trusted check manifest read-only and points the agent at it", () => {
  const args = buildDockerArgs({
    docker: ["docker"],
    image: "img",
    hostWorkspace: "/ws",
    provider: "codex",
    checkManifestPath: "C:\\Repos\\coding-agent\\config\\manifest.json",
  });
  assert.ok(
    args.includes(
      `type=bind,source=C:\\Repos\\coding-agent\\config\\manifest.json,target=${CONTAINER_CHECK_MANIFEST},readonly`,
    ),
  );
  assert.ok(args.includes(`SPEC_AGENT_CHECK_MANIFEST=${CONTAINER_CHECK_MANIFEST}`));
  assert.equal(args[args.length - 1], "img");
});

test("buildDockerArgs passes no check manifest when none is configured", () => {
  const args = buildDockerArgs({ docker: ["docker"], image: "img", hostWorkspace: "/ws", provider: "mock" });
  assert.ok(!args.some((arg) => arg.includes(CONTAINER_CHECK_MANIFEST)));
});

test("buildDockerArgs carries extra prefix arguments from the docker command", () => {
  const args = buildDockerArgs({
    docker: ["node", "/tmp/fake-docker.cjs"],
    image: "img",
    hostWorkspace: "/ws",
    provider: "mock",
  });
  assert.deepEqual(args.slice(0, 2), ["/tmp/fake-docker.cjs", "run"]);
});

test("parseAgentResult reads the single JSON result document", () => {
  const run = parseAgentResult('{"status":"spec_ready","summary":"ok"}', "log line", 0);
  assert.equal(run.result?.status, "spec_ready");
  assert.equal(run.exitCode, 0);
  assert.equal(run.timedOut, false);
  assert.equal(run.rawStderr, "log line");
});

test("parseAgentResult keeps raw streams when stdout is not a JSON object", () => {
  assert.equal(parseAgentResult("boom", "trace", 30).result, null);
  assert.equal(parseAgentResult("[1,2]", "", 0).result, null);
  assert.equal(parseAgentResult("", "", 125).result, null);
  assert.equal(parseAgentResult("boom", "trace", 30).rawStdout, "boom");
});

test("parseAgentResult propagates a non-zero exit alongside a parsed result", () => {
  const run = parseAgentResult('{"status":"blocked","blockingConcerns":["INTENT_MUTATED"]}', "", 20);
  assert.equal(run.exitCode, 20);
  assert.equal(run.result?.status, "blocked");
});
