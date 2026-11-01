# Human Records at Board Transitions

The Orchestrator treats a Trello move as a request to validate a lifecycle transition. Product-owner authorization comes from the Trello actor ID and the product's pinned `product.yaml`; display names are not authority. A record is a Trello card comment whose first line contains a schema-named JSON envelope:

```text
<!-- agentic-sdlc-human-record {"definition":"SpecAcceptanceRecord","record":{...}} -->
```

The JSON value must validate against the named definition in the canonical [lifecycle schema](https://github.com/dbacks95fan/agentic-sdlc/blob/main/schemas/lifecycle-contracts.schema.json). Record comments are visible workflow evidence. The authoritative artifacts named by a record must still be immutable Git references with content hashes.

For Spec & Design, Execution, and Evaluation, the Orchestrator also stores the schema-validated `StageInvocation` and `StageResult` JSON in Trello comments, marked `agentic-sdlc-stage-invocation` and `agentic-sdlc-stage-result`. Both records carry the same invocation ID. For Execution and Evaluation it then records a schema-validated `StageResultDecision` (`agentic-sdlc-stage-result-decision`): `accepted` after it verifies the pushed package read-only on GitHub, or `rejected` with the reason. The decision lives on the card rather than as a Git artifact, because the Orchestrator never writes to product repositories.

## Spec Acceptance

The product owner accepts `spec.md` and the proposed Work Contract by moving the card from `Spec & Design` to `Execution`. The move is the decision; nobody writes a record by hand. The Orchestrator then builds the `SpecAcceptanceRecord` itself, with `authorized_by` set to the Trello member who moved the card, `recorded_at` set to the time of the move, and `spec` and `work_contract` set to the artifact references in the latest `spec_ready` StageResult. It posts the record on the card as an `agentic-sdlc-human-record` comment, then starts Execution.

Execution does not start, and the card holds for resolution, unless every check passes:

- The card has an active Prioritized freeze.
- The newest Spec & Design StageResult on the card is `spec_ready`. An older ready spec cannot be accepted after a later run was blocked, failed, or needs a decision.
- That result belongs to the active freeze's product, intent, and version, references both `spec.md` and `work-contract.yaml`, and has a valid StageInvocation, which supplies the target base revision.
- The Trello actor is an authorized product owner in the pinned `product.yaml`.
- `spec` and `work_contract` identify the same GitHub repository and commit, and the Orchestrator retrieves both from GitHub and verifies their SHA-256 hashes.
- `work-contract.yaml` validates as Work Contract v3 and binds the same product, intent, version, frozen intent/profile references, and product repository.
After that gate passes, the Orchestrator checks the accepted contract's `required_validation` and sends the Coding Agent a StageInvocation 1.1 for the accepted work branch. The check accepts only these exact supported pairs: `build` / `npm run build`, `automated_tests` / `npm run test:server`, `playwright` / `npm run test:e2e`, and `docker_build` / `docker build -t coding-agent-validation:latest .`. Unsupported names or command differences hold the card in Execution for resolution.

A recorded Spec Acceptance Record looks like this, with sample values:

```json
{
  "schema_version": "1.0",
  "work_item": {
    "product_id": "MF",
    "intent_id": "INT-MF-0042",
    "intent_version": 3,
    "trello_card_id": "<TRELLO_CARD_ID>"
  },
  "decision": "accepted_for_execution",
  "authorized_by": "<TRELLO_MEMBER_ID>",
  "recorded_at": "2026-10-27T12:00:00Z",
  "spec": {
    "repository": "https://github.com/<owner>/<product-repo>",
    "commit_sha": "<40-TO-64-CHARACTER-COMMIT-SHA>",
    "path": "<repository-relative-spec.md-path>",
    "sha256": "<64-CHARACTER-SHA256>"
  },
  "work_contract": {
    "repository": "https://github.com/<owner>/<product-repo>",
    "commit_sha": "<same-commit-sha-as-spec>",
    "path": "<repository-relative-work-contract.yaml-path>",
    "sha256": "<64-CHARACTER-SHA256>"
  }
}
```

## Human Approval

The product owner decides by moving the card out of `Human Approval`, the same way Spec Acceptance works:

| Move to | Recorded decision |
| --- | --- |
| `Release` | `approved_for_integration_and_release` |
| `Execution` | `return_to_execution` |
| `Spec & Design` | `return_to_spec_and_design` |
| `Done` | `stopped`, plus a `ClosureRecord` with outcome `stopped` |

The Orchestrator builds the `HumanApprovalRecord` from the newest Evaluation result on the card, which must be a `pass` with an accepted `StageResultDecision` under the active freeze. It sets `candidate`, `evidence`, and `evaluation` from that run, `authorized_by` to the Trello member who moved the card, and `recorded_at` to the time of the move. It posts the record as an `agentic-sdlc-human-record` comment. If those conditions do not hold, nothing is recorded and the card holds with a comment.

`rationale` (and a stop's `reason`) comes from the owner's newest comment that starts with `Rationale:` or `Reason:` and was written after the evaluation result. The canonical record requires a rationale, so without one nothing is recorded: the card holds with a comment asking for one. Comment `Rationale: ...` on the card before moving it; to retry, move the card back to Human Approval and then to its destination again.

The Orchestrator acts on Trello with the product owner's identity, so Trello cannot tell its actions from the owner's. Two rules keep the owner's decisions the owner's own. The Orchestrator moves cards only along its routes (Execution to Evaluation, Evaluation to Human Approval or back to Execution, and Prioritized back to Backlog when a freeze fails), and only if the card is still where the route starts; it never moves a card out of Human Approval, Release, or Production Observation. It also refuses to post any comment that starts with `Rationale:`, `Reason:`, or `Deploy:`, so relayed agent text can never pass as the owner's reason or deployment authorization.

Approval does not merge or release anything; the authorized integration path does. A return to Execution or Spec & Design is recorded but not started automatically, because neither agent yet accepts a human's free-text feedback as a durable input.

## Release

Approval is followed by two things only the owner does, and one the deploy service does:

1. **Merge.** The approval note links the pull request from the work branch. The owner merges it into `main` with **Create a merge commit** once its required checks pass. The Orchestrator never merges.
2. **Authorize the deployment** with a comment on the card in Release:

   ```
   Deploy: production
   Rationale: <why it may go to production now>
   ```

3. **Deploy.** On that comment the Orchestrator re-reads it from Trello and checks: the card is in Release under an active freeze; the author is an authorized product owner; the newest `HumanApprovalRecord` is `approved_for_integration_and_release`; the candidate is not already released; and, read-only on GitHub, the newest merged pull request from the work branch merged exactly the evaluated commit, with a merge commit whose second parent is that commit, now on `main`. Any failure is explained on the card and nothing is deployed.

   It then records the canonical `DeploymentAuthorizationRecord` (an `agentic-sdlc-human-record` comment): the integration commit, environment, owner, time, rationale, and a `TrelloRecordRef` to the owner's comment with the SHA-256 of its exact text. It sends that record to the deploy service (`DEPLOY_SERVICE_API_URL`), which re-checks the commit and its CI on GitHub, builds and starts it, health-checks it, and rolls back if it is unhealthy.

4. **Release Record.** From the deploy service's report the Orchestrator writes the schema-valid `ReleaseRecord` 1.1 as an `agentic-sdlc-release-record` comment: candidate and integration commits, a `TrelloRecordRef` to the Human Approval Record comment, the embedded Deployment Authorization Record, the actions, the verification results, any rollback, and the status. A `released` card can be moved to Production Observation by the owner; `rolled_back`, `failed`, and `blocked` keep it in Release, and a new `Deploy:` comment tries again. If the deploy service gives no report, no Release Record is written and the card says the outcome is unknown.

Each `Deploy:` comment is handled once, so a repeated webhook delivery does not deploy twice, and a released candidate is never deployed again.

## Production Observation and Done

`ObservationRecord` is owned by the observation control, which does not exist yet, so the Orchestrator does not validate those transitions or treat a pasted record as a gate. It never declares production outcomes or closes released work on a human's behalf.
