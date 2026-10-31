// ABOUTME: Test stand-in for the docker CLI: runs the Spec & Design Agent contract against the bind-mount source.
// ABOUTME: Behaviour is selected with FAKE_DOCKER_MODE (spec_ready | needs_decision | garbage | hang).
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");

const argv = process.argv.slice(2);
if (argv[0] !== "run") {
  // `docker kill <name>` on the timeout path — nothing to do.
  process.exit(0);
}

// Record the argv so tests can assert on the flags the orchestrator passed.
if (process.env.FAKE_DOCKER_ARGV_LOG) {
  fs.writeFileSync(process.env.FAKE_DOCKER_ARGV_LOG, JSON.stringify(argv), "utf8");
}

const mount = argv[argv.indexOf("--mount") + 1] || "";
const source = (mount.match(/source=([^,]+)/) || [])[1];
const target = (mount.match(/target=([^,]+)/) || [])[1] || "/work";
if (!source) {
  process.stderr.write("fake-docker: no bind mount source\n");
  process.exit(125);
}

const containerRequest = argv[argv.indexOf("--request") + 1];
const hostRequest = path.join(source, containerRequest.slice(target.length + 1));
const request = JSON.parse(fs.readFileSync(hostRequest, "utf8"));
if (process.env.FAKE_DOCKER_MODE === "hang") {
  setTimeout(() => process.exit(0), 60_000);
  return;
}
const repositoryRoot = path.join(source, "repository");
if (!fs.existsSync(path.join(repositoryRoot, ".git"))) {
  const targetRepo = process.env.FAKE_DOCKER_TARGET_REPO;
  if (!targetRepo) {
    process.stderr.write("fake-docker: no product repository fixture configured\n");
    process.exit(125);
  }
  cp.execFileSync("git", ["clone", "--no-hardlinks", "--no-checkout", targetRepo, repositoryRoot], { stdio: "pipe" });
  cp.execFileSync("git", ["checkout", "--detach", request.target.baseCommit], { cwd: repositoryRoot, stdio: "pipe" });
  cp.execFileSync("git", ["checkout", "-b", request.target.branch, request.target.baseCommit], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
}

const mode = process.env.FAKE_DOCKER_MODE || "spec_ready";

if (mode === "garbage") {
  process.stderr.write("Traceback (most recent call last):\n  RuntimeError: provider exploded\n");
  process.stdout.write("not a json result document");
  process.exit(30);
}

// The real agent verifies the invocation snapshots before copying them to its work directory.
const inputDirectory = path.join(source, ".agent", "inputs", request.invocationId);
const intent = fs.readFileSync(path.join(inputDirectory, "intent.md"));
const policyProfile = fs.readFileSync(path.join(inputDirectory, "policy-profile.md"));
const sha = crypto.createHash("sha256").update(intent).digest("hex");
const profileSha = crypto.createHash("sha256").update(policyProfile).digest("hex");
const freeze = request.freezeActivation;
const base = {
  runId: request.runId,
  invocationId: request.invocationId,
  triggerEventId: request.triggerEventId,
  stage: request.stage,
  workItem: request.workItem,
  productId: request.productId,
  intentVersion: freeze.work_item.intent_version,
  trelloCardId: freeze.work_item.trello_card_id,
  status: "blocked",
  summary: "",
  branch: request.target.branch,
  workspace: request.target.workspace,
  intentCommit: freeze.intent.commit_sha,
  frozenArtifactSha256: freeze.intent.sha256,
  policyProfileId: freeze.policy_profile_id,
  policyProfileVersion: freeze.policy_profile_version,
  policyProfileSha256: freeze.policy_profile.sha256,
  intentContentSha256: request.intentContentSha256,
  blockingConcerns: [],
  nonBlockingConcerns: [],
  humanDecisions: [],
};

if (sha !== freeze.intent.sha256 || profileSha !== freeze.policy_profile.sha256) {
  process.stdout.write(JSON.stringify({ ...base, summary: "INTENT_MUTATED", blockingConcerns: ["INTENT_MUTATED"] }));
  process.exit(20);
}

if (mode === "needs_decision") {
  process.stdout.write(
    JSON.stringify({
      ...base,
      status: "needs_decision",
      summary: "A storage boundary decision is required.",
      humanDecisions: [
        {
          question: "Which service owns meal-plan persistence?",
          impact: "Determines the affected bounded context.",
          options: ["Reuse the recipe service", "Introduce a planner service"],
          minimumAuthority: "Product engineering lead",
        },
      ],
    }),
  );
  process.exit(10);
}

const specRelPath = path.posix.join(".agent", "work", request.workItem, "spec.md");
const workContractRelPath = path.posix.join(".agent", "work", request.workItem, "work-contract.yaml");
fs.mkdirSync(path.dirname(path.join(repositoryRoot, specRelPath)), { recursive: true });
fs.writeFileSync(path.join(repositoryRoot, ".agent", "work", request.workItem, "intent.md"), intent);
fs.writeFileSync(path.join(repositoryRoot, ".agent", "work", request.workItem, "policy-profile.md"), policyProfile);
fs.writeFileSync(
  path.join(repositoryRoot, specRelPath),
  "# Requirements and Design Specification\n\n## Traceability to frozen intent\n",
);
fs.writeFileSync(path.join(repositoryRoot, workContractRelPath), "schema_version: 3\n");
const git = (args) =>
  cp
    .execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=Spec Agent", ...args], { cwd: repositoryRoot })
    .toString()
    .trim();
// Force-add only authorized outputs, matching the real agent's artifact contract.
git([
  "add",
  "--force",
  "--",
  ".agent/work/" + request.workItem + "/intent.md",
  ".agent/work/" + request.workItem + "/policy-profile.md",
  specRelPath,
  workContractRelPath,
]);
git(["commit", "-m", `spec: ${request.workItem}`]);
const specCommit = git(["rev-parse", "HEAD"]);

process.stdout.write(
  JSON.stringify({
    ...base,
    status: "spec_ready",
    summary: "Specification produced from the frozen intent.",
    specCommit,
    specPath: specRelPath,
    specSha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(repositoryRoot, specRelPath)))
      .digest("hex"),
    specVersion: 1,
    workContractPath: workContractRelPath,
    workContractSha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(repositoryRoot, workContractRelPath)))
      .digest("hex"),
  }),
);
