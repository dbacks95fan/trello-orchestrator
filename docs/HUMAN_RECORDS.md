# Human Records at Board Transitions

The Orchestrator treats a Trello move as a request to validate a lifecycle transition. Product-owner authorization comes from the Trello actor ID and the product's pinned `product.yaml`; display names are not authority. A record is a Trello card comment whose first line contains a schema-named JSON envelope:

```text
<!-- agentic-sdlc-human-record {"definition":"SpecAcceptanceRecord","record":{...}} -->
```

The JSON value must validate against the named definition in the canonical [lifecycle schema](https://github.com/dbacks95fan/agentic-sdlc/blob/main/schemas/lifecycle-contracts.schema.json). Record comments are visible workflow evidence. The authoritative artifacts named by a record must still be immutable Git references with content hashes.

For Spec & Design, the Orchestrator also stores the schema-validated `StageInvocation` and `StageResult` JSON in Trello comments, marked `agentic-sdlc-stage-invocation` and `agentic-sdlc-stage-result`. Both records carry the same invocation ID. The canonical `StageResultDecision` Git artifact is not emitted yet.

## Spec Acceptance

Moving a card from `Spec & Design` to `Execution` requires a valid `SpecAcceptanceRecord`. The card remains in place unless all checks pass:

- The Trello actor is an authorized product owner and is the `authorized_by` identity in the record.
- `work_item` matches the card and the active Prioritized freeze.
- `spec` and `work_contract` identify the same GitHub repository and commit.
- The Orchestrator retrieves both artifacts from GitHub and verifies their SHA-256 hashes.
- The references match the latest validated `spec_ready` StageResult, whose `StageInvocation` supplies the target base revision.
- `work-contract.yaml` validates as Work Contract v3 and binds the same product, intent, version, frozen intent/profile references, and product repository.

After that gate passes, the Orchestrator checks the accepted contract's `required_validation` and sends the Coding Agent a StageInvocation 1.1 for the accepted work branch. The check accepts only these exact supported pairs: `build` / `npm run build`, `automated_tests` / `npm run test:server`, `playwright` / `npm run test:e2e`, and `docker_build` / `docker build -t coding-agent-validation:latest .`. Unsupported names or command differences hold the card in Execution for resolution.

Example shape (replace all sample values with actual immutable references and hashes):

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

## Other Human Decisions

The canonical lifecycle defines `HumanApprovalRecord`, `ReleaseRecord`, `ObservationRecord`, and `ClosureRecord`. In this Orchestrator version, those later records are **not yet validated or used to authorize downstream actions**. The Orchestrator observes the associated list transitions and leaves the decision to the accountable human. It does not release software, declare production outcomes, or close work on a human's behalf.

The user may add a schema-named record comment for those stages for visibility, but that comment is not currently an enforced gate. Do not treat it as proof that the Orchestrator verified the decision or artifact references.
