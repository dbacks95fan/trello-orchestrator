// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Stands in for the local Spec & Design CLI in Orchestrator integration tests.
const fs = require("node:fs");
const path = require("node:path");
const requestIndex = process.argv.indexOf("--request");
const requestPath = requestIndex >= 0 ? process.argv[requestIndex + 1] : "";
const request = requestPath ? JSON.parse(fs.readFileSync(requestPath, "utf8")) : null;
if (process.env.FAKE_LOCAL_SPEC_LOG) {
  fs.writeFileSync(
    process.env.FAKE_LOCAL_SPEC_LOG,
    JSON.stringify({
      args: process.argv.slice(2),
      request,
      provider: process.env.SPEC_AGENT_PROVIDER,
      cwd: process.cwd(),
    }),
  );
}
console.log(JSON.stringify({ status: "spec_ready", summary: "local stub completed" }));
