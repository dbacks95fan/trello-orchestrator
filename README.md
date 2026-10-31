# Trello Orchestrator

Webhook-driven control-plane service for the Agentic SDLC. It validates Trello
webhook signatures, interprets authorized list transitions, verifies frozen
work inputs, invokes assigned agents, and records visible workflow evidence.
The canonical process is documented in
[`agentic-sdlc/docs/WORKFLOW.md`](https://github.com/dbacks95fan/agentic-sdlc/blob/main/docs/WORKFLOW.md).

The Orchestrator has no product-specific board or list IDs. Each product's
`ProductConfig` 1.1 supplies the Trello board ID and the list ID for each of the
ten canonical stages. Existing boards can use different list names because
stage routing uses configured IDs, not visual order or name matching. The
Intent Creation Skill creates the initial card in New Ideas; the Orchestrator owns
subsequent workflow state and freeze metadata. Each running instance currently
subscribes to the single board selected by `TRELLO_BOARD_ID`; it can be set up
for any product board, but simultaneous multi-board processing is not supported.

| Authorized transition | Orchestrator action |
| --- | --- |
| Backlog → Prioritized | Validate the pinned intent/profile and product-owner ID; record schema-valid freeze activation data and the current projection. |
| Prioritized → Spec & Design | Verify the active freeze, record a StageInvocation, and invoke Spec & Design. Only a schema-valid Work Contract v3 bound to frozen inputs can be reported ready for human review. |
| Spec & Design → Execution | Require a product-owner `SpecAcceptanceRecord` comment on the card; retrieve the referenced spec and Work Contract from GitHub, verify hashes, and validate Work Contract v3 against the active freeze. |
| Execution (entry) | Build StageInvocation 1.1 from the accepted artifacts and run the Coding Agent. Validate its StageResult and Evidence Package, record the Evaluator handoff, and move a `candidate_complete` card to Evaluation. |
| Evaluation (entry) | Call the NAS Evaluator with the candidate SHA and the exact contract, evidence, and intent bytes. Validate the returned Evaluation Package reference and move a `pass` to Human Approval. `fail` and `needs_decision` stay in Evaluation. |
| Human Approval and later | Check in-order movement and product-owner identity only. Human Approval, Release, Production Observation, and Done records are not yet validated. |

Returning a card from Prioritized or Spec & Design to Backlog or New Ideas
revokes its active freeze while preserving the event history. The webhook
boundary uses the product's configured Trello board and list IDs, checks current card state,
blocks out-of-order moves, validates owner identity, and deduplicates event IDs.
Later human records are not enforced yet; see
[`docs/HUMAN_RECORDS.md`](docs/HUMAN_RECORDS.md).

The Orchestrator owns all Trello reads and writes. It calls the Trello REST API
directly with a key/token/secret; none of the agents it invokes has Trello
access.

The Orchestrator never writes product-repository Git refs. Each agent commits
and pushes its own output to `work/<intent-id>`: the Spec & Design Agent its
spec and Work Contract, the Coding Agent its candidate and Evidence Package,
and the Evaluator its Evaluation Package. The Orchestrator reads the returned
references, checks them with a read-only GitHub App token, and records them on
the card. The Evaluator runs on the NAS; it checks out the candidate SHA into
temporary container storage and removes the checkout before responding.

## Structure

```
src/
├── server.ts                      Express app: webhook endpoint, transition dispatch, startup/registration
├── config.ts                      env var loading + the shared webhookUrl constant
├── runtimeConfig.ts               locates the runtime env file outside project repositories
├── githubApp.ts                   mints repository-scoped, read-only GitHub App tokens
├── boardTemplate.ts               loads the canonical Trello board template
├── boardBootstrap.ts              reconciles a board to the template lists
├── boardBootstrapCli.ts           `npm run bootstrap-board` dry-run/apply command
├── manualSpecDesignCli.ts         `npm run spec-design:manual` local operator command
├── contracts/
│   └── lifecycle.ts               validates records against the canonical lifecycle schema
├── trello/
│   ├── client.ts                  thin Trello REST API wrapper (lists, cards, comments, webhooks)
│   ├── webhookVerify.ts           HMAC signature check on incoming deliveries
│   └── webhookEvent.ts            card-move action -> canonical BoardTransitionEvent
├── workflow/
│   ├── workflow.ts                queues and per-stage handlers (freeze, Spec & Design, Execution, Evaluation)
│   ├── boardTransition.ts         validates, deduplicates, and authorizes board transitions
│   ├── transitionPolicy.ts        configured list IDs -> allowed in-order transitions
│   ├── wip.ts                     WIP limit check against the configured Execution list ID
│   ├── freezeState.ts             reads/writes the current card freeze projection
│   ├── specRequestFromCard.ts     card metadata + intent-backlog fetch -> Spec & Design request
│   ├── specWorkspace.ts           stages frozen intent/profile snapshots in an invocation bundle
│   ├── specRouting.ts             Spec & Design result -> card comment + decision brief
│   ├── workContractV3.ts          checks a proposed Work Contract v3 against the active freeze
│   ├── humanRecords.ts            parses and verifies SpecAcceptanceRecord comments
│   ├── acceptedExecutionContract.ts  revalidates acceptance and builds the Execution StageInvocation
│   ├── codingContractAdapter.ts   checks accepted validation names/commands against the supported gates
│   └── contractFromCard.ts        Work Contract type shared by the adapter
├── codingAgent/
│   └── runCodingAgent.ts          runs the Coding Agent's `run --invocation` command as a subprocess
├── specDesignAgent/
│   └── runSpecDesignAgent.ts      runs the spec-design-agent image as a one-shot container
└── evaluatorAgent/
    ├── gitHandoff.ts              builds the read-only Evaluator handoff from Coding Agent references
    └── remote.ts                  authenticated request to the NAS Evaluator
```

Grouped by concern rather than kept flat: `trello/` is everything that talks to
Trello's API, `workflow/` is the orchestration logic that doesn't care which
task-tracker it came from, and each `*Agent/` directory is one integration
point with an agent it invokes.

## Spec & Design trigger

When a card enters the configured `Spec & Design` list ID the orchestrator acts as the first
engineering-stage handler for that work item:

1. It reads the intent projection the Intent Creation Skill writes onto the card
   description — `Product` (or `Product ID`), `Intent ID`, `Intent Version`,
   `Intent Commit`, `Intent Hash`, `Canonical intent`, `Policy Profile ID`,
   and `Policy Profile Version` (`src/workflow/specRequestFromCard.ts`). An Active Orchestrator
   freeze must be present before the agent can start.
2. It fetches the exact `intent.md` bytes from the `intent-backlog` repository at
   the pinned `Intent Commit` through the GitHub contents API, and refuses to
   continue if the card and canonical intent disagree on identity, version,
   content hash, or policy-profile ID/version. It resolves `product.yaml` and
   the selected profile at that same pinned commit and verifies the profile.
3. It creates an invocation bundle under `SPEC_WORKSPACE_ROOT` containing
   byte-exact frozen inputs at `.agent/inputs/<invocation-id>/intent.md` and
   `policy-profile.md`. The Spec & Design Agent clones the configured GitHub
   product repository, checks out the assigned base commit, creates
   `work/<intent-id>`, and owns its artifact commit and push. This keeps Git
   branch ownership with the agent, whether it runs in Docker or locally.
4. It builds a request v2 per `spec-design-agent/schemas/spec-request.schema.json`
   (`runId`, `invocationId`, `triggerEventId`, work identity, the typed
   `FreezeActivationEvent`, target, and path permissions), and a canonical
   StageInvocation 1.1 with the same freeze and invocation IDs. It writes the request
   into the invocation bundle, then runs the agent in the configured runtime
   (`src/specDesignAgent/runSpecDesignAgent.ts`). Docker remains the default;
   local Codex CLI execution is available for manual development runs.

   ```
   docker run --rm --mount type=bind,source=<invocation-bundle>,target=/work \
     --mount type=bind,source=<invocation-bundle>/.agent/inputs/<invocation-id>,target=/work/.agent/inputs/<invocation-id>,readonly \
     --read-only --tmpfs /tmp -e HOME=/tmp -e SPEC_AGENT_PROVIDER=<provider> \
     -e GIT_CONFIG_COUNT=3 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/work \
     -e GIT_CONFIG_KEY_1=user.email -e GIT_CONFIG_KEY_2=user.name ... \
     --security-opt no-new-privileges:true --cap-drop ALL \
     --env-file <runtime.env> <image> spec --request /work/spec-design-request.json
   ```

   The flags mirror the hardening in `spec-design-agent/compose.yaml`. The
   request's `target.workspace` is `/work/repository`, not the host path, because
   the agent clones the product repository there. A run that overruns
   `SPEC_DESIGN_AGENT_TIMEOUT_MS` is killed and reported as a timeout.

   The `GIT_CONFIG_*` variables are load-bearing, not decoration: without
   `safe.directory=/work` git aborts with *"detected dubious ownership in
   repository at '/work'"* when the container's non-root uid does not own the
   bind-mounted files, which would stop the agent at its first workspace check.
   Setting them by environment avoids needing a writable `HOME` or rootfs. A `-c`
   flag from the agent still takes precedence.

   The Spec & Design Agent receives a product-repository GitHub App installation
   token as `SPEC_AGENT_GITHUB_TOKEN`. The token value is not in Docker's command
   arguments, but it is present in the container environment and can be inspected
   by principals with Docker daemon access. Restrict daemon access accordingly.
   The token needs write permission because the agent creates and publishes its branch.
5. It routes on the agent's result (`src/workflow/specRouting.ts`):
   `spec_ready` → publish a branch link for human review and leave the card in
   Spec & Design;
   `needs_decision` → leave the card in Spec & Design with itemised decisions;
   `blocked` / `failed` / unparseable → leave the card in place with a
   comment. Human review remains in this column; the orchestrator never approves it.
6. The agent pushes its branch after committing. The Orchestrator only verifies
   that the branch is visible on GitHub, then comments the link so the human
   Design Reviewer can open it. The Orchestrator never writes product-repository
   Git refs.

The Prioritized transition records a schema-valid activation event and the
authorizing Trello member ID. Spec & Design re-resolves both artifacts and
checks their exact fingerprints against that freeze before invocation. It also
records a schema-valid StageInvocation and StageResult. A generated spec is
not an approval; human review remains within Spec & Design.

A `spec_ready` result must name the committed `spec.md` path, Work Contract
path, and commit (`specPath`, `workContractPath`, `specCommit`). The
Orchestrator reads both files at that commit from the agent's clone in the
invocation bundle, validates the Work Contract v3 against the frozen inputs,
and records their hashes in the StageResult. A result without those references,
or with a contract that fails validation, is recorded as `blocked`. A live
Spec & Design run against a real product repository has not yet been verified.

After a valid acceptance, the Orchestrator checks that every `required_validation`
name and command in the accepted contract is one the Coding Agent supports
exactly, and blocks the card in Execution if not. It then sends the Coding Agent
a StageInvocation 1.1 whose input artifacts are the accepted spec and Work
Contract. Later Human Approval, Release, Production Observation, and Done
records remain manual and are not enforced by this build.

## What it does, step by step

1. Trello POSTs an `updateCard` webhook event whenever anything on the board
   changes.
2. `src/trello/webhookVerify.ts` checks the `X-Trello-Webhook` HMAC signature
   against the raw request body — deliveries that don't verify are rejected
   with 401 and never reach the workflow logic.
3. `src/trello/webhookEvent.ts` converts only list moves into canonical events
   using Trello board, card, list, actor, and event IDs. The Orchestrator verifies
   current card state, allowed order, owner identity, and event deduplication.
4. The Prioritized transition records the freeze. Entering Spec & Design records
   a schema-valid StageInvocation and invokes the Spec & Design Agent. Its
   schema-valid StageResult must include committed `spec.md` and Work Contract v3
   references, or the Orchestrator blocks the handoff.
5. Moving to Execution requires a product-owner SpecAcceptanceRecord. The
   Orchestrator checks its schema, authorization, work identity, immutable artifact
   hashes, StageResult references, Work Contract v3 fields, and target revision.
6. The Orchestrator accepts only validation names and commands that exactly
   match its fixed list in `src/workflow/codingContractAdapter.ts` (`build`,
   `automated_tests`, `playwright`, `docker_build`). The Coding Agent separately
   checks them against its own operator manifest. The Orchestrator then sends a StageInvocation 1.1 targeting
   the accepted spec commit on `work/<intent-id>` to the Coding Agent.
7. The Coding Agent commits and pushes the candidate and its Evidence Package
   itself. For a `candidate_complete` result, the Orchestrator validates the
   StageResult and Evidence Package against the canonical schema and writes the
   repository URL, candidate SHA, and artifact references to the Evaluator
   handoff comment, then moves the card to Evaluation.
8. When the card enters the configured `Evaluation` list ID, the Orchestrator
   calls the authenticated `EVALUATOR_API_URL` endpoint. The Evaluator checks
   out the supplied SHA into request-scoped temporary storage, evaluates it,
   publishes its Evaluation Package to the work branch, and returns its result
   and the package reference.
9. A non-candidate Coding Agent result leaves the card in Execution. A passing
   Evaluation moves the card to Human Approval. A failing evaluation stays in
   Evaluation; the rework route back to Execution is not built yet. Later human
   records and Release/Observation/Done transitions are not yet enforced. The
   Orchestrator never moves a card to Done.

## Setup

```
npm install
npm run build
cp .env.example .env   # fill in Trello credentials, TRELLO_BOARD_ID, and CALLBACK_URL
```

You need a public HTTPS URL for `CALLBACK_URL` before starting — Trello's
webhook API cannot call a LAN-only address. A Cloudflare quick tunnel is the
fastest way to get one with no account/domain required:

```
cloudflared tunnel --url http://localhost:8787
```

Copy the `https://<random>.trycloudflare.com` URL it prints into `.env` as
`CALLBACK_URL` (with `/webhooks/trello` NOT appended — the server adds that
path itself when registering the webhook), then:

```
npm start
```

On startup it resolves the board's real id, and calls Trello's webhook API to
create (or reuse, if one already exists for this exact callback URL) the
subscription — idempotent, safe to restart.

Set `EVALUATOR_API_URL` to the NAS evaluator address and `EVALUATOR_API_TOKEN`
to the same bearer token configured by the evaluator. Store the bearer token in
the Orchestrator's `C:\Repos\.config\orchestrator\runtime.env` file, not in a
repository. Set `ORCHESTRATOR_SECRETS_FILE` only if you use another location.
The Orchestrator runtime file also needs `ORCHESTRATOR_GITHUB_APP_ID`,
`ORCHESTRATOR_GITHUB_APP_INSTALLATION_ID`, and
`ORCHESTRATOR_GITHUB_APP_PRIVATE_KEY_FILE`. Keep the private key in the
Orchestrator's external config directory. The Orchestrator mints a repository-
scoped read token when it fetches product artifacts. Keep
`INTENT_BACKLOG_READ_TOKEN` for the private intent-backlog repository only.
The Evaluator runtime file needs `EVALUATOR_ALLOWED_REPOSITORY_URLS` and its
own GitHub App ID, installation ID, and private-key path. Evaluator mints a
read-only token for checkout and a separate write token only to publish the
Evaluation Package on the assigned work branch.
For the Spec & Design trigger, build and deploy the agent image on this host from
the [spec-design-agent](https://github.com/dbacks95fan/spec-design-agent) repo:

```
cd ../spec-design-agent
New-Item -ItemType Directory -Force C:\Repos\.config\spec-design-agent | Out-Null
Copy-Item .env.example C:\Repos\.config\spec-design-agent\runtime.env
# Fill in the provider key and the Spec Agent's GitHub App credential in that external file.
docker compose build           # tags spec-design-agent:local
```

Then in the Orchestrator, keep its own settings and secrets in
`C:\Repos\.config\orchestrator\runtime.env`. Keep the Spec & Design Agent's
provider key and product-repository GitHub App credential in its separate file,
`C:\Repos\.config\spec-design-agent\runtime.env`; that file is passed directly
to the agent runtime. Use `INTENT_BACKLOG_READ_TOKEN` only for the private
intent-backlog repository. Provision the full canonical board lifecycle with
the command below rather than adding individual lists by hand.

## Board provisioning

The versioned lifecycle template is owned by
`agentic-sdlc/templates/trello-board-workflow.yaml`. Use the Orchestrator to
inspect a board before changing it:

```
npm run bootstrap-board -- --dry-run
```

When the report contains no duplicate or unexpected lists, apply the template:

```
npm run bootstrap-board -- --apply
```

The command creates missing canonical lists and establishes their order on an
existing board. It never creates a board, moves cards, or deletes lists. It
refuses to apply when existing lists make template reconciliation ambiguous.
Runtime transition routing uses the explicit list IDs in the product's
reviewed `ProductConfig` 1.1.

The orchestrator never builds the image — if Docker is not running or the image
is missing, the card gets a comment saying so and stays in Spec & Design; the
coding and evaluation triggers are unaffected.

### Local Spec & Design run (development only)

For a manual local run, set `SPEC_DESIGN_KICKOFF_MODE=manual` in the Orchestrator
webhook runtime. Moving a card into Spec & Design then records the transition and
posts the local command instead of starting the agent. In the Windows Orchestrator
checkout, set `SPEC_DESIGN_RUNTIME=local`, `SPEC_DESIGN_AGENT_PROVIDER=codex`,
and `SPEC_DESIGN_AGENT_DIR` to the local Spec & Design Agent checkout, then run:

```
npm run spec-design:manual -- --card-id <trello-card-id>
```

This local command still uses the Orchestrator's Trello and GitHub credentials to
verify the active freeze, stage exact input snapshots, and run the agent. The
agent clones the product repository at its current GitHub default-branch commit,
creates the work branch, commits, and pushes its own artifacts. Codex CLI uses
the local Windows sign-in. The container path remains the default and the
canonical deployment target.

## Known limitations (v0.1, on purpose)

- **Quick tunnels are ephemeral.** Restarting `cloudflared` gives a new URL,
  which means a new webhook registration — the old one is left dangling on
  Trello (harmless, just unused) until manually cleaned up. A named tunnel with
  a real domain would fix this; out of scope for now.
- **The WIP queue is in-memory only.** A card queued in `Execution` when the
  Orchestrator restarts is not picked up again. Moving it out of Execution is
  an out-of-order move and is blocked, so there is no supported re-trigger yet;
  the card needs human resolution.
- **One board per instance.** Each running instance subscribes to the single
  board in `TRELLO_BOARD_ID`; the canonical multi-board registry is not
  implemented.
- **Execution reads a local product clone.** Building the Execution invocation
  runs read-only `git` commands against a clone under `SPEC_WORKSPACE_ROOT`, so
  the Orchestrator must run on the host that ran Spec & Design.
