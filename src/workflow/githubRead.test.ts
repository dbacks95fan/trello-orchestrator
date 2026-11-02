// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for the read-only GitHub lookups: branch tips, files at a commit, merged pulls, and ancestry.
import assert from "node:assert/strict";
import test from "node:test";
import { isOnBranch, readBranchTip, readFileAtCommit, readMergedPullRequests } from "./githubRead.js";

const SHA = "c".repeat(40);
const base = {
  repositoryUrl: "https://github.com/Example/MealFlow.git",
  apiBase: "https://api.github.com/",
  token: "t",
};

function recording(response: () => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return response();
  };
  return { calls, fetchFn };
}

test("reads a branch tip through the exact-match ref endpoint, keeping the branch's slashes", async () => {
  const { calls, fetchFn } = recording(() => Response.json({ object: { sha: SHA, type: "commit" } }));
  assert.equal(await readBranchTip({ ...base, branch: "work/INT-MF-0042", fetchFn }), SHA);
  assert.equal(calls[0].url, "https://api.github.com/repos/Example/MealFlow/git/ref/heads/work/INT-MF-0042");
  assert.equal(calls[0].headers.Authorization, "Bearer t");
});

test("refuses a missing branch, a non-commit ref, and a non-GitHub repository", async () => {
  await assert.rejects(
    readBranchTip({ ...base, branch: "work/X", fetchFn: recording(() => new Response("", { status: 404 })).fetchFn }),
    /HTTP 404 while reading the tip of work\/X/,
  );
  await assert.rejects(
    readBranchTip({
      ...base,
      branch: "work/X",
      fetchFn: recording(() => Response.json({ object: { sha: SHA, type: "tag" } })).fetchFn,
    }),
    /did not return a commit SHA/,
  );
  await assert.rejects(
    readBranchTip({ ...base, repositoryUrl: "https://gitlab.com/a/b", branch: "main", fetchFn: fetch }),
    /must be an HTTPS GitHub URL/,
  );
});

test("returns a file's exact bytes at a commit, including a byte order mark and CRLF", async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Intent\r\n")]);
  const { calls, fetchFn } = recording(() => new Response(bytes));
  const read = await readFileAtCommit({ ...base, commit: SHA, path: ".agent/work/INT 1/intent.md", fetchFn });
  assert.ok(read.equals(bytes));
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/Example/MealFlow/contents/.agent/work/INT%201/intent.md?ref=${SHA}`,
  );
  assert.equal(calls[0].headers.Accept, "application/vnd.github.raw+json");
});

test("refuses unsafe paths, short revisions, and missing files", async () => {
  const ok = recording(() => new Response("x")).fetchFn;
  await assert.rejects(readFileAtCommit({ ...base, commit: SHA, path: "../secret", fetchFn: ok }), /cannot traverse/);
  await assert.rejects(
    readFileAtCommit({ ...base, commit: SHA, path: "/etc/passwd", fetchFn: ok }),
    /repository-relative/,
  );
  await assert.rejects(readFileAtCommit({ ...base, commit: "main", path: "a.md", fetchFn: ok }), /full commit SHA/);
  await assert.rejects(
    readFileAtCommit({
      ...base,
      commit: SHA,
      path: "a.md",
      fetchFn: recording(() => new Response("", { status: 404 })).fetchFn,
    }),
    /HTTP 404 while reading a.md at cccccccccccc/,
  );
});

test("lists only merged pull requests from the work branch, newest merge first", async () => {
  const { calls, fetchFn } = recording(() =>
    Response.json([
      { number: 1, merged_at: "2026-11-01T10:00:00Z", merge_commit_sha: "a".repeat(40), head: { sha: "b".repeat(40) } },
      { number: 2, merged_at: null, merge_commit_sha: "c".repeat(40), head: { sha: "d".repeat(40) } },
      { number: 3, merged_at: "2026-11-01T12:00:00Z", merge_commit_sha: "e".repeat(40), head: { sha: "f".repeat(40) } },
    ]),
  );
  const pulls = await readMergedPullRequests({ ...base, fetchFn, head: "work/INT-MF-0042", base: "main" });
  assert.deepEqual(
    pulls.map((p) => p.number),
    [3, 1],
  );
  assert.equal(pulls[0].headSha, "f".repeat(40));
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/repos/Example/MealFlow/pulls");
  assert.equal(url.searchParams.get("head"), "Example:work/INT-MF-0042");
  assert.equal(url.searchParams.get("state"), "closed");
  assert.equal(url.searchParams.get("base"), "main");
  assert.equal(calls[0].headers.Authorization, "Bearer t");
});

test("a commit is on the branch only when the comparison says it is the tip or behind it", async () => {
  for (const [status, expected] of [
    ["identical", true],
    ["behind", true],
    ["ahead", false],
    ["diverged", false],
  ] as const) {
    const { calls, fetchFn } = recording(() => Response.json({ status }));
    assert.equal(await isOnBranch({ ...base, fetchFn, commit: SHA, branch: "main" }), expected, status);
    assert.ok(calls[0].url.endsWith(`/repos/Example/MealFlow/compare/main...${SHA}`), calls[0].url);
  }
  await assert.rejects(
    () =>
      isOnBranch({
        ...base,
        fetchFn: recording(() => new Response("", { status: 404 })).fetchFn,
        commit: SHA,
        branch: "main",
      }),
    /HTTP 404/,
  );
  await assert.rejects(() => isOnBranch({ ...base, commit: "abc", branch: "main" }), /full commit SHA/);
});
