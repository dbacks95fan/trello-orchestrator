// ABOUTME: Prepares an invocation bundle and frozen input snapshots for the Spec & Design Agent.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);

// Run Git without a shell so an intent id can never alter the command structure.
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}
export interface PrepareSpecWorkspaceInput {
  targetRepository: string;
  baseCommit: string;
  workspaceRoot: string;
  intentId: string;
  invocationId: string;
  frozenIntentBytes: Buffer;
  frozenPolicyProfileBytes: Buffer;
}

export interface SpecWorkspace {
  /** Invocation bundle bind-mounted into the container at /work. */
  path: string;
  /** Agent-owned product clone inside the invocation bundle. */
  repositoryPath: string;
  branch: string;
  baseCommit: string;
  frozenArtifactSha256: string;
  /** HTTPS remote the clone's origin points at, shared with the container. */
  remoteUrl: string;
  created: boolean;
}

/** Stages the frozen inputs in an invocation bundle. The agent clones the product
 *  repository and owns creation and publication of its work branch. */
export async function prepareSpecWorkspace(input: PrepareSpecWorkspaceInput): Promise<SpecWorkspace> {
  const branch = `work/${input.intentId}`;
  const path = resolve(input.workspaceRoot, `${input.intentId}-${input.invocationId}`);
  const remoteUrl = input.targetRepository.replace(/\.git$/, "").replace(/\/$/, "");
  if (!remoteUrl.startsWith("https://")) {
    throw new Error(
      `ProductConfig target_repository must be an HTTPS GitHub URL so the Spec & Design Agent can clone the product repository; found "${remoteUrl || "none"}".`,
    );
  }
  const existed = existsSync(path);
  await mkdir(path, { recursive: true });
  const repositoryPath = join(path, "repository");
  if (existsSync(join(repositoryPath, ".git"))) {
    throw new Error(`The Spec & Design Agent workspace already contains a product repository: ${repositoryPath}`);
  }
  const inputDirectory = join(path, ".agent", "inputs", input.invocationId);
  await mkdir(inputDirectory, { recursive: true });
  const intentPath = join(inputDirectory, "intent.md");
  const policyProfilePath = join(inputDirectory, "policy-profile.md");
  if (existsSync(intentPath) && !(await readFile(intentPath)).equals(input.frozenIntentBytes)) {
    throw new Error("The invocation already has a different frozen intent snapshot.");
  }
  if (existsSync(policyProfilePath) && !(await readFile(policyProfilePath)).equals(input.frozenPolicyProfileBytes)) {
    throw new Error("The invocation already has a different frozen policy-profile snapshot.");
  }
  await writeFile(intentPath, input.frozenIntentBytes);
  await writeFile(policyProfilePath, input.frozenPolicyProfileBytes);

  const frozenArtifactSha256 = createHash("sha256").update(input.frozenIntentBytes).digest("hex");
  return {
    path,
    repositoryPath,
    branch,
    baseCommit: input.baseCommit,
    frozenArtifactSha256,
    remoteUrl,
    created: !existed,
  };
}

/** Read only a committed work artifact so worker working-tree changes cannot masquerade as a published output. */
export async function readCommittedWorkspaceFile(
  workspacePath: string,
  revision: string,
  relativePath: string,
): Promise<string> {
  const absolutePath = resolve(workspacePath, relativePath);
  const workspaceRelative = relative(workspacePath, absolutePath);
  if (
    !/^[0-9a-f]{40,64}$/.test(revision) ||
    !relativePath ||
    isAbsolute(relativePath) ||
    workspaceRelative === ".." ||
    workspaceRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error("Worker artifact path must be a safe workspace-relative path.");
  }
  const { stdout } = await execFileAsync("git", ["show", `${revision}:${relativePath.replace(/\\/g, "/")}`], {
    cwd: workspacePath,
    windowsHide: true,
    encoding: "utf8",
  });
  return stdout;
}

export interface VerifySpecBranchResult {
  pushed: boolean;
  branchUrl: string;
  reason?: string;
}

/** Confirms the agent's branch is visible on the remote without writing refs. */
export async function verifySpecBranchPublished(
  workspace: Pick<SpecWorkspace, "path" | "branch" | "remoteUrl">,
  token: string,
): Promise<VerifySpecBranchResult> {
  const branchUrl = `${workspace.remoteUrl.replace(/\.git$/, "")}/tree/${workspace.branch}`;
  const authHeader = token
    ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
    : undefined;
  const authEnv = authHeader
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: authHeader,
      }
    : {};
  try {
    const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", "origin", workspace.branch], {
      cwd: workspace.path,
      windowsHide: true,
      env: { ...process.env, ...authEnv },
    });
    return stdout.trim()
      ? { pushed: true, branchUrl }
      : { pushed: false, branchUrl, reason: "The Spec & Design Agent branch is not visible on the remote." };
  } catch (err) {
    return { pushed: false, branchUrl, reason: err instanceof Error ? err.message : String(err) };
  }
}
