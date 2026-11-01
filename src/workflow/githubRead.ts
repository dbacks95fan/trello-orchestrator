// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Read-only GitHub lookups for a product repository: a branch tip and a file's exact bytes at a commit.
// ABOUTME: Lets Execution check accepted work against GitHub instead of a local workspace whose path may differ.

export interface GitHubReadOptions {
  repositoryUrl: string;
  apiBase: string;
  token: string;
  fetchFn?: typeof fetch;
}

function repositoryApi(options: GitHubReadOptions): string {
  const match = options.repositoryUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match) throw new Error("The product repository must be an HTTPS GitHub URL naming one owner and repository.");
  return `${options.apiBase.replace(/\/$/, "")}/repos/${match[1]}/${match[2]}`;
}

function headers(token: string, accept: string): Record<string, string> {
  const result: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "trello-orchestrator",
  };
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

/** The commit a branch points at now. The ref lookup matches the branch name exactly, never a tag or prefix. */
export async function readBranchTip(options: GitHubReadOptions & { branch: string }): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const encodedBranch = options.branch.split("/").map(encodeURIComponent).join("/");
  const response = await fetchFn(`${repositoryApi(options)}/git/ref/heads/${encodedBranch}`, {
    headers: headers(options.token, "application/vnd.github+json"),
  });
  if (!response.ok)
    throw new Error(`GitHub returned HTTP ${response.status} while reading the tip of ${options.branch}.`);
  const ref = (await response.json()) as { object?: { sha?: unknown; type?: unknown } };
  const sha = ref.object?.sha;
  if (ref.object?.type !== "commit" || typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))
    throw new Error(`GitHub did not return a commit SHA for ${options.branch}.`);
  return sha;
}

/** The parent commit SHAs of one commit. */
export async function readCommitParents(options: GitHubReadOptions & { commit: string }): Promise<string[]> {
  const fetchFn = options.fetchFn ?? fetch;
  if (!/^[0-9a-f]{40,64}$/.test(options.commit)) throw new Error("Parents can only be read for a full commit SHA.");
  const response = await fetchFn(`${repositoryApi(options)}/git/commits/${options.commit}`, {
    headers: headers(options.token, "application/vnd.github+json"),
  });
  if (!response.ok)
    throw new Error(`GitHub returned HTTP ${response.status} while reading commit ${options.commit.slice(0, 12)}.`);
  const commit = (await response.json()) as { parents?: { sha?: unknown }[] };
  return (commit.parents ?? []).map((parent) => String(parent.sha ?? ""));
}

/** A committed file's raw bytes. Bytes, not text, so a fingerprint check sees exactly what Git stores. */
export async function readFileAtCommit(options: GitHubReadOptions & { commit: string; path: string }): Promise<Buffer> {
  const fetchFn = options.fetchFn ?? fetch;
  if (!/^[0-9a-f]{40,64}$/.test(options.commit)) throw new Error("A file can only be read at a full commit SHA.");
  const { path } = options;
  if (!path || path.startsWith("/") || path.split(/[\\/]/).includes(".."))
    throw new Error("The file path must be repository-relative and cannot traverse directories.");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetchFn(
    `${repositoryApi(options)}/contents/${encodedPath}?ref=${encodeURIComponent(options.commit)}`,
    { headers: headers(options.token, "application/vnd.github.raw+json") },
  );
  if (!response.ok)
    throw new Error(`GitHub returned HTTP ${response.status} while reading ${path} at ${options.commit.slice(0, 12)}.`);
  return Buffer.from(await response.arrayBuffer());
}
