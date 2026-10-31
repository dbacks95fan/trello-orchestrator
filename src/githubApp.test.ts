// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Verifies repository and permission scoping for Orchestrator GitHub App tokens.
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitHubAppReadToken } from "./githubApp.js";

test("mints a contents-read token scoped to the assigned product repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-app-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyFile = join(directory, "app.pem");
  await writeFile(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), "utf8");
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  try {
    const token = await createGitHubAppReadToken({
      appId: "12345",
      installationId: "67890",
      privateKeyFile,
      repositoryUrl: "https://github.com/example/mealflow.git",
      now: () => Date.parse("2026-10-31T12:00:00.000Z"),
      fetchFn: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify({ token: "test-installation-token" }), { status: 201 });
      },
    });

    assert.equal(token, "test-installation-token");
    assert.equal(requestUrl, "https://api.github.com/app/installations/67890/access_tokens");
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      repositories: ["mealflow"],
      permissions: { contents: "read" },
    });
    const authorization = new Headers(requestInit?.headers).get("authorization");
    assert.ok(authorization?.startsWith("Bearer "));
    const jwt = authorization!.slice("Bearer ".length).split(".");
    const claims = JSON.parse(Buffer.from(jwt[1], "base64url").toString("utf8")) as {
      iss: string;
      iat: number;
      exp: number;
    };
    assert.equal(claims.iss, "12345");
    assert.equal(claims.exp - claims.iat, 540);
    assert.equal(
      verify("RSA-SHA256", Buffer.from(`${jwt[0]}.${jwt[1]}`), publicKey, Buffer.from(jwt[2], "base64url")),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects non-GitHub repositories before requesting an app token", async () => {
  await assert.rejects(
    createGitHubAppReadToken({
      appId: "12345",
      installationId: "67890",
      privateKeyFile: "unused.pem",
      repositoryUrl: "https://example.com/owner/repo.git",
    }),
    /HTTPS GitHub repository URL/,
  );
});
