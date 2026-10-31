// ABOUTME: Runs the Spec & Design Agent as a one-shot Docker container and captures its one JSON result.
import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "../config.js";

/** The bounded request the Spec & Design Agent consumes.
 *  Shape mirrors spec-design-agent/schemas/spec-request.schema.json. */
export interface SpecDesignRequest {
  requestVersion: 2;
  runId: string;
  invocationId: string;
  triggerEventId: string;
  stage: "spec_design";
  workItem: string;
  productId: string;
  intentContentSha256?: string;
  freezeActivation: {
    schema_version: "1.0";
    event_id: string;
    event_type: "activated";
    work_item: {
      product_id: string;
      intent_id: string;
      intent_version: number;
      trello_card_id: string;
    };
    intent: { repository: string; commit_sha: string; path: string; sha256: string };
    policy_profile_id: string;
    policy_profile_version: string;
    policy_profile: { repository: string; commit_sha: string; path: string; sha256: string };
    authorized_by: string;
    recorded_at: string;
  };
  target: {
    repository: string;
    baseCommit: string;
    branch: string;
    workspace: string;
  };
  readPaths: string[];
  writePaths: string[];
}

export interface SpecDesignResult {
  exitCode: number | null;
  result: Record<string, unknown> | null;
  rawStdout: string;
  rawStderr: string;
  timedOut: boolean;
}

/** The mount point of the work-item workspace inside the container. The request's
 *  `target.workspace` must be this path, not the host path, because the agent
 *  resolves it from inside the container. */
export const CONTAINER_WORKSPACE = "/work";
/** Where the operator check manifest is mounted read-only inside the container. */
export const CONTAINER_CHECK_MANIFEST = "/config/check-manifest.json";
const REQUEST_BASENAME = "spec-design-request.json";

export interface DockerRunSpec {
  docker: string[];
  image: string;
  hostWorkspace: string;
  inputSnapshotPath?: string;
  invocationId?: string;
  provider: string;
  envFile?: string | null;
  containerName?: string;
  /** Host path of the trusted check manifest the Coding Agent also enforces. */
  checkManifestPath?: string | null;
}

/** Git refuses to operate on a bind-mounted repository whose owner differs from
 *  the container user ("detected dubious ownership"), which would stop the agent
 *  at its first workspace check. These env-only settings fix that without a
 *  writable HOME or rootfs, and supply a commit identity so the agent's artifact
 *  commit cannot fail for want of one. Any `-c` flag the agent passes wins over
 *  these, so they are a floor, not an override. */
const GIT_ENV: string[] = [
  "-e",
  "GIT_CONFIG_KEY_0=safe.directory",
  "-e",
  `GIT_CONFIG_VALUE_0=${CONTAINER_WORKSPACE}`,
  "-e",
  "GIT_CONFIG_KEY_1=user.email",
  "-e",
  "GIT_CONFIG_VALUE_1=agent@agentic-sdlc.local",
  "-e",
  "GIT_CONFIG_KEY_2=user.name",
  "-e",
  "GIT_CONFIG_VALUE_2=Spec and Design Agent",
];

/** Builds the `docker run` argv up to and including the image. Mirrors the
 *  hardening in spec-design-agent/compose.yaml: read-only rootfs, tmpfs /tmp,
 *  dropped capabilities, no privilege escalation, workspace bind-mounted rw. */
export function buildDockerArgs(spec: DockerRunSpec): string[] {
  const args = [
    ...spec.docker.slice(1),
    "run",
    "--rm",
    "--mount",
    `type=bind,source=${spec.hostWorkspace},target=${CONTAINER_WORKSPACE}`,
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-e",
    "HOME=/tmp",
    "-e",
    `SPEC_AGENT_PROVIDER=${spec.provider}`,
    "-e",
    "GIT_CONFIG_COUNT=3",
    ...GIT_ENV,
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
  ];
  if (spec.inputSnapshotPath && spec.invocationId) {
    args.push(
      "--mount",
      `type=bind,source=${spec.inputSnapshotPath},target=${CONTAINER_WORKSPACE}/.agent/inputs/${spec.invocationId},readonly`,
    );
  }
  if (spec.checkManifestPath) {
    args.push(
      "--mount",
      `type=bind,source=${spec.checkManifestPath},target=${CONTAINER_CHECK_MANIFEST},readonly`,
      "-e",
      `SPEC_AGENT_CHECK_MANIFEST=${CONTAINER_CHECK_MANIFEST}`,
    );
  }
  if (spec.envFile) args.push("--env-file", spec.envFile);
  if (spec.containerName) args.push("--name", spec.containerName);
  args.push(spec.image);
  return args;
}

/** Parses the single JSON result document the agent prints to stdout. Anything
 *  else (a crash, a stack trace) leaves `result` null with the raw streams kept. */
export function parseAgentResult(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  timedOut = false,
): SpecDesignResult {
  let result: Record<string, unknown> | null = null;
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        result = parsed as Record<string, unknown>;
      }
    } catch {
      // stdout was not the single JSON result document.
    }
  }
  return { exitCode, result, rawStdout: stdout, rawStderr: stderr, timedOut };
}

export interface RunSpecDesignAgentOptions {
  /** Absolute host path of the prepared workspace clone (bind-mounted at /work). */
  hostWorkspace: string;
  docker?: string[];
  image?: string;
  provider?: string;
  /** `null` omits `--env-file` entirely; omitted falls back to configuration. */
  envFile?: string | null;
  /** `null` passes no check manifest; omitted falls back to configuration. */
  checkManifestPath?: string | null;
  timeoutMs?: number;
  runtime?: "docker" | "local";
  localCommand?: string[];
  agentDirectory?: string;
}

export async function runSpecDesignAgent(
  request: SpecDesignRequest,
  options: RunSpecDesignAgentOptions,
): Promise<SpecDesignResult> {
  const provider = options.provider ?? config.specDesignProvider;
  const runtime = options.runtime ?? config.specDesignRuntime;
  const checkManifestPath =
    options.checkManifestPath === undefined ? config.specDesignCheckManifest : options.checkManifestPath;
  if (runtime === "local") {
    return runLocalSpecDesignAgent(request, options.hostWorkspace, provider, checkManifestPath, options);
  }
  if (runtime !== "docker") {
    return parseAgentResult("", `Unsupported Spec & Design runtime: ${runtime}`, null);
  }
  const docker = options.docker ?? [config.specDesignDockerBin];
  const image = options.image ?? config.specDesignImage;
  const envFile = options.envFile === undefined ? config.specDesignRuntimeEnvFile : options.envFile;
  const timeoutMs = options.timeoutMs ?? config.specDesignTimeoutMs;

  const requestHostPath = join(options.hostWorkspace, REQUEST_BASENAME);
  const requestContainerPath = `${CONTAINER_WORKSPACE}/${REQUEST_BASENAME}`;
  await writeFile(requestHostPath, JSON.stringify(request, null, 2), "utf8");

  const dockerArgs = buildDockerArgs({
    docker,
    image,
    hostWorkspace: options.hostWorkspace,
    inputSnapshotPath: join(options.hostWorkspace, ".agent", "inputs", request.invocationId),
    invocationId: request.invocationId,
    provider,
    envFile,
    containerName: `spec-design-${request.runId}`,
    checkManifestPath,
  });
  const argv = [...dockerArgs, "spec", "--request", requestContainerPath];

  return new Promise((resolvePromise) => {
    const child = spawn(docker[0], argv, { env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      spawn(docker[0], [...docker.slice(1), "kill", `spec-design-${request.runId}`], { stdio: "ignore" }).on(
        "error",
        () => undefined,
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    // A failed spawn emits both `error` and `close`; settle on whichever comes
    // first so the result cannot depend on which cleanup promise lands first.
    let settled = false;
    const settle = (exitCode: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderrWithError = spawnError ? `${stderr}\n${String(spawnError)}` : stderr;
      // Remove the transient request before resolving so the workspace handed
      // to later stages carries only committed artifacts.
      void rm(requestHostPath, { force: true })
        .catch(() => undefined)
        .then(() => resolvePromise(parseAgentResult(stdout, stderrWithError, exitCode, timedOut)));
    };

    child.on("error", (err) => settle(null, err));
    child.on("close", (exitCode) => settle(exitCode));
  });
}

/** Runs the bounded agent CLI on this machine, using its existing Codex login.
 *  This is useful for local development while production remains container-based. */
async function runLocalSpecDesignAgent(
  request: SpecDesignRequest,
  hostWorkspace: string,
  provider: string,
  checkManifestPath: string | null,
  options: RunSpecDesignAgentOptions,
): Promise<SpecDesignResult> {
  const requestPath = join(hostWorkspace, REQUEST_BASENAME);
  await writeFile(requestPath, JSON.stringify(request, null, 2), "utf8");
  const command = options.localCommand ?? [config.specDesignUvBin];
  const runtimeEnvFile = options.envFile === undefined ? config.specDesignRuntimeEnvFile : options.envFile;
  const uvEnvArgs =
    runtimeEnvFile && /^uv(?:\.exe)?$/i.test(basename(command[0])) ? ["--env-file", runtimeEnvFile] : [];
  const args = [
    ...command.slice(1),
    "run",
    ...uvEnvArgs,
    "spec-design-agent",
    "spec",
    "--request",
    requestPath,
    "--provider",
    provider,
  ];
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], args, {
      cwd: options.agentDirectory ?? config.specDesignAgentDirectory,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Spec and Design Agent",
        GIT_AUTHOR_EMAIL: "agent@agentic-sdlc.local",
        GIT_COMMITTER_NAME: "Spec and Design Agent",
        GIT_COMMITTER_EMAIL: "agent@agentic-sdlc.local",
        SPEC_AGENT_PROVIDER: provider,
        ...(checkManifestPath ? { SPEC_AGENT_CHECK_MANIFEST: checkManifestPath } : {}),
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? config.specDesignTimeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    let settled = false;
    const settle = (exitCode: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderrWithError = spawnError ? `${stderr}\n${String(spawnError)}` : stderr;
      void rm(requestPath, { force: true })
        .catch(() => undefined)
        .then(() => resolvePromise(parseAgentResult(stdout, stderrWithError, exitCode, timedOut)));
    };
    child.on("error", (err) => settle(null, err));
    child.on("close", (exitCode) => settle(exitCode));
  });
}
