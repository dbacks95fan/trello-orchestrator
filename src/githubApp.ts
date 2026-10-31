// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Mints repository-scoped GitHub App read tokens for product artifact access.
import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface GitHubAppReadTokenRequest {
  appId: string;
  installationId: string;
  privateKeyFile: string;
  repositoryUrl: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function githubRepository(repositoryUrl: string): string {
  const match = repositoryUrl
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match) throw new Error("GitHub App access requires an HTTPS GitHub repository URL.");
  return match[2];
}

function appJwt(appId: string, privateKey: string, now: number): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iss: appId, iat: issuedAt, exp: issuedAt + 540 }));
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${base64Url(sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(privateKey)))}`;
}

export async function createGitHubAppReadToken(request: GitHubAppReadTokenRequest): Promise<string> {
  if (!request.appId || !request.installationId || !request.privateKeyFile) {
    throw new Error("Orchestrator GitHub App ID, installation ID, and private-key file are required.");
  }
  const repository = githubRepository(request.repositoryUrl);
  const privateKey = await readFile(request.privateKeyFile, "utf8");
  const jwt = appJwt(request.appId, privateKey, (request.now ?? Date.now)());
  const response = await (request.fetchFn ?? fetch)(
    `https://api.github.com/app/installations/${encodeURIComponent(request.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "User-Agent": "agentic-sdlc-orchestrator",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ repositories: [repository], permissions: { contents: "read" } }),
    },
  );
  if (!response.ok) throw new Error(`GitHub App could not mint an Orchestrator read token (HTTP ${response.status}).`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token)
    throw new Error("GitHub App token response did not contain an installation token.");
  return body.token;
}
