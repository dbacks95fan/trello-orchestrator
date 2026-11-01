# Project journal

## 2026-09-04

The evaluator handoff is being changed from a local filesystem dependency to an immutable Git-revision handoff. The work is constrained to the orchestrator and evaluator repositories; the Coding Agent and MealFlow repositories remain untouched.

The host Node 24 test runner cannot start `tsx` because `uv_os_get_passwd` returns an ENOMEM error. The same suites run successfully in the Dockerized Node 20 runtime used by the evaluator.

## 2026-09-06

Added a third webhook trigger: a card entering **Spec & Design** now runs the
Spec & Design Agent. New modules `workflow/specRequestFromCard.ts` (card
projection + intent-backlog fetch + integrity check), `workflow/specWorkspace.ts`
(creates `work/<intent-id>` worktree, freezes `intent.md`, hashes it),
`specDesignAgent/runSpecDesignAgent.ts` (subprocess), `workflow/specRouting.ts`
(result → board move). `server.ts` and `workflow.ts` gained a parallel queue.

Decisions, all made to follow the agentic-sdlc docs:

- **Local subprocess**, not Docker or a NAS service — the deployment-boundary
  doc allows a local-process worker and it matches `runCodingAgent`.
- **Intent identity** comes from the card's metadata block
  (`work-tracking.md` "Trello card contract"); the **frozen bytes and hash**
  come from `intent-backlog` at the pinned `Intent Commit` via the GitHub
  contents API. Card↔backlog disagreement on id/product/version/status/hash is a
  hard stop with a card comment.
- **The orchestrator does the freeze** (worktree + staged `intent.md` +
  `frozenArtifactSha256`) so the hash precondition is checked Orchestrator-side
  before the agent runs. The agent re-verifies the bytes as its own gate.
- **`approval` is approximated**: `approvedAt` = frontmatter `frozen_at` or the
  move timestamp; `approvedBy` = the Trello member who moved the card. Flagged
  in the README as needing a real Ready-for-Planning capture later.
- **List names** `Spec & Design` / `Design Review` are env-overridable and
  resolved lazily, so a board without them still starts the existing flow.
- `SPEC_DESIGN_AGENT_CLI` is optional in config; unset → card comment, no crash.

Left alone: the coding/eval half still uses the retired board vocabulary and a
`TARGET_REPO`-committed intent. The two halves don't meet end to end yet — noted
in the README, out of scope here.

Pre-existing unrelated failure still red: `src/runtimeConfig.test.ts` asserts a
POSIX path and fails on Windows (`C:\workspace\...` vs `\workspace\...`). Not
touched.

Later the same day: the Spec & Design Agent must run as a Docker container
deployed to this machine, not as a local subprocess. Two consequences worth
recording, because the second one forced a rewrite:

- `runSpecDesignAgent.ts` now shells `docker run --rm` with the workspace
  bind-mounted at `/work`, replicating the hardening in the agent's own
  `compose.yaml` (read-only rootfs, tmpfs `/tmp`, `HOME=/tmp`, `cap-drop ALL`,
  `no-new-privileges`). `SPEC_DESIGN_AGENT_IMAGE` replaces the CLI command; the
  orchestrator never builds the image. Added a hard timeout that kills the run.
- **`git worktree` cannot work here.** A worktree's `.git` is a link file
  holding an absolute host path into the parent repo's `.git/worktrees/`, which
  does not resolve inside the container — and mounting the parent repo would not
  fix it, because a Windows host path is meaningless to a Linux container.
  `specWorkspace.ts` now makes a full local clone instead: self-contained `.git`,
  all history so `baseCommit` is verifiable offline, and `origin` removed since
  it points at an unreachable host path. This replaced yesterday's worktree
  implementation rather than patching it — the constraint changed, not the code.

`target.workspace` in the request is `/work`, not the host path: the agent
resolves it from inside the container. The request file is written into the
workspace as `spec-design-request.json` and removed after the run.

Tests use a `fake-docker.cjs` fixture standing in for the docker CLI, so unit,
integration, and e2e stay hermetic and offline. A real-daemon run against the
built image is still a deployment-verification step, not something the suite
covers.

Probed the flag set against the real daemon rather than trusting it, and caught
a defect the hermetic tests could never have found: git aborts with **"detected
dubious ownership in repository at '/work'"** when the container's non-root uid
does not own the bind-mounted files. The agent would have died at its first
workspace check, every time. Fixed by passing `safe.directory=/work` plus a
commit identity through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
`GIT_CONFIG_VALUE_n`, which needs neither a writable HOME nor a writable rootfs.
Re-verified against the daemon: status, branch resolution, staging, commit, and
author identity all work under `--read-only` as uid 10001.

Also dropped a redundant `--workdir /app` — the image already sets it. (It first
showed up as a bogus `C:/Program Files/Git/app` because Git Bash rewrote the
path in my manual probe; Node's `spawn` does no such conversion, so it was never
a product bug, just a misleading test artifact.)

## 2026-09-07

Deployed `spec-design-agent:local` to Docker Desktop. Build was blocked by a
transposed base-image tag: `python:3.12-bookworm-slim` does not exist, it is
`python:3.12-slim-bookworm`. (The uv builder tag genuinely is `bookworm-slim` —
astral uses the opposite convention, which is likely how it crept in.)

Ran the image through the orchestrator's real code path against a mealflow clone
with `provider=mock`. Everything on our side worked — mount, safe.directory,
read-only rootfs, request round-trip, result parsing, routing, TARGET_REPO
untouched — and the agent got as far as writing `spec.md` before failing:

    git add -- .agent/work/INT-MF-0042/{intent.md,spec.md,spec-run.json} -> exit 1

Reproduced in isolation: `mealflow/.gitignore:19` ignores `.agent/`, and plain
`git add` refuses ignored paths. `git add --force` stages them. The agent uses
plain `git add`; our `specWorkspace.ts` and the evaluator's `gitHandoff.ts` both
already force. Left the fix to Sobe — either the agent forces, or mealflow stops
ignoring `.agent/work/` — because it is a policy call across his repos, unlike
the Dockerfile tag which had one right answer.

### GitHub from inside the container

Measured before changing anything: **network egress and CA trust already worked**
— the container reads a public repo fine. The only gaps were credentials and a
usable remote. So this was never a networking change.

- `specWorkspace.ts` now *retargets* origin to the target repo's real HTTPS URL
  instead of removing it. Cloning from the local path stays fast and credential
  free, but the clone now carries a remote that resolves identically on the host
  and in the container. Refuses a target repo whose origin is not HTTPS.
- The container receives the product-repository GitHub App installation token
  through environment pass-through as `SPEC_AGENT_GITHUB_TOKEN`. The Spec & Design
  Agent creates and pushes its branch, so this role needs write access to its
  assigned product repository. The value is not in Docker command arguments, but
  Docker daemon users can inspect the container environment, so daemon access must
  be restricted.
- The Orchestrator separately uses `INTENT_BACKLOG_READ_TOKEN` for the private
  intent-backlog repository and a read-only GitHub App token for product-repository
  validation. It does not reuse either token for the agent's branch writes.
- The Evaluator's publisher uses its own GitHub App write token to add the
  Evaluation Package to the candidate branch. The Evaluator itself remains
  read-only with respect to candidate code.

A test caught a UX defect worth noting: with no origin at all, `git config --get`
exits non-zero, so the cryptic "Command failed" surfaced instead of the
actionable message. Now tolerated and reported properly.

## 2026-10-31

Sobe decided the Coding Agent runs only as the authenticated HTTP service on the
NAS, using Claude through the API, never as a local CLI. `runCodingAgent.ts` now
POSTs the Execution StageInvocation 1.1 to `CODING_AGENT_API_URL/invocations`
with `CODING_AGENT_API_TOKEN` and polls `/invocations/{id}`. `CODING_AGENT_CLI`
and `CODING_AGENT_RUNTIME_ENV` are gone, so the Orchestrator no longer loads the
Coding Agent's model key or GitHub credentials to start it.

Decisions:

- **Busy is not retried.** A second submission while the service is busy could
  collide with whatever else is running, so `409` is reported for a human.
- **Status polls are retried.** A poll is a read, so up to three consecutive
  failures are tolerated and logged before the outcome is reported as unknown.
- **A lost run is unknown, not failed.** The service keeps results in memory; a
  `404` while polling means it restarted, so the card is held for triage.
Later on 2026-10-31: the Spec Acceptance Record is now written by the Orchestrator,
not pasted by hand. Per agentic-sdlc Stage Contracts §3, the product owner's move
from Spec & Design to Execution is the acceptance; `specAcceptance.ts` binds that
move (actor, time) to the newest `spec_ready` artifacts and records it.

- **Only the newest Spec & Design result counts.** If a later run was blocked or
  failed, an earlier ready spec is not silently accepted.
- **The hand-written record path was removed** rather than kept alongside, so
  there is one way to accept a spec.
Later still on 2026-10-31: Execution no longer reads a local product clone. It
looked for the accepted work at `SPEC_WORKSPACE_ROOT/<intent-id>`, but Spec &
Design runs in `<intent-id>-<invocation-id>/repository`, so a new card would have
stopped at Execution. The one end-to-end test had built its repository at the
old path, which is why it never failed.

- **Read from GitHub at the accepted commit.** The branch tip and the frozen
  intent copy come from the product repository's API, the same source Spec
  Acceptance already checks, so Execution works on any host.
- **Bytes, not text.** The frozen intent copy is fetched as raw bytes, so a
  byte order mark or line-ending change cannot slip past the fingerprint.

2026-11-01, overnight: Evaluation now follows the canonical contract end to end.
The custom Evaluator handoff comment and request are gone. Execution and
Evaluation runs are recorded on the card as StageInvocation and StageResult, and
the Evaluation invocation is built from the recorded Execution run.

- **Verified before routed.** Each pushed package is checked read-only on GitHub
  (branch tip, parent chain, hash, schema, required checks), and the outcome is a
  StageResultDecision on the card: accepted, or rejected with the reason.
- **Rework is bounded and category-routed.** Only implementation or evidence
  failures go back to Execution, at most twice per freeze by default. A spec or
  policy defect waits for the accountable human.
- **One client for both NAS workers,** since they share the same HTTP boundary.

Also 2026-11-01: moving a card out of Human Approval now records a schema-valid
HumanApprovalRecord against the newest verified pass, and a ClosureRecord for a
stop. The rationale is the owner's own "Rationale:" comment, or a plain statement
that none was given; it is never invented. Release and Observation records are
left alone on purpose: their owners (the release and observation controls) don't
exist yet, and the canonical ReleaseRecord points at the approval with a Git
ArtifactRef while the approval lives on the card, a gap flagged upstream.
