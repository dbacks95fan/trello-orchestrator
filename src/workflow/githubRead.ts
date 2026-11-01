// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Read-only GitHub lookups for a product repository: branch tips, commits, files, and merged pull requests.
// ABOUTME: Lets the Conductor check handoffs and integrations against GitHub instead of a local workspace.

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

export interface MergedPullRequest {
  number: number;
  headSha: string;
  mergeCommitSha: string;
  mergedAt: string;
}

/** Merged pull requests from one branch into another, newest merge first. Closed-unmerged ones are left out. */
export async function readMergedPullRequests(
  options: GitHubReadOptions & { head: string; base: string },
): Promise<MergedPullRequest[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const api = repositoryApi(options);
  const owner = api.split("/repos/")[1].split("/")[0];
  const query = new URLSearchParams({
    state: "closed",
    head: `${owner}:${options.head}`,
    base: options.base,
    per_page: "20",
  });
  const response = await fetchFn(`${api}/pulls?${query.toString()}`, {
    headers: headers(options.token, "application/vnd.github+json"),
  });
  if (!response.ok)
    throw new Error(`GitHub returned HTTP ${response.status} while reading pull requests from ${options.head}.`);
  const pulls = (await response.json()) as {
    number?: unknown;
    merged_at?: unknown;
    merge_commit_sha?: unknown;
    head?: { sha?: unknown };
  }[];
  return pulls
    .filter((pull) => typeof pull.merged_at === "string" && typeof pull.merge_commit_sha === "string")
    .map((pull) => ({
      number: Number(pull.number),
      headSha: String(pull.head?.sha ?? ""),
      mergeCommitSha: String(pull.merge_commit_sha),
      mergedAt: String(pull.merged_at),
    }))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
}

/** True when the commit is the branch tip or in its history. */
export async function isOnBranch(options: GitHubReadOptions & { commit: string; branch: string }): Promise<boolean> {
  const fetchFn = options.fetchFn ?? fetch;
  if (!/^[0-9a-f]{40,64}$/.test(options.commit)) throw new Error("Only a full commit SHA can be compared.");
  const response = await fetchFn(
    `${repositoryApi(options)}/compare/${encodeURIComponent(options.branch)}...${options.commit}`,
    { headers: headers(options.token, "application/vnd.github+json") },
  );
  if (!response.ok)
    throw new Error(`GitHub returned HTTP ${response.status} while comparing ${options.commit.slice(0, 12)}.`);
  // Comparing branch...commit: "behind" means the commit is in the branch's history; "identical" means it is the tip.
  const { status } = (await response.json()) as { status?: unknown };
  return status === "identical" || status === "behind";
}
