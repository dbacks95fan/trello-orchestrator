// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests the Release stage end to end against fakes: the owner's Deploy comment, the merge check, the
// ABOUTME: Deployment Authorization Record, the deploy call, and the Release Record for each outcome.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createLifecycleValidator } from "../contracts/lifecycle.js";
import { config } from "../config.js";
import type { TrelloCard, TrelloComment } from "../trello/client.js";
import type { CardCommentEvent } from "../trello/webhookEvent.js";
import { writeFreezeProjection } from "./freezeState.js";
import type { MergedPullRequest } from "./githubRead.js";
import { humanRecordComment } from "./humanApproval.js";
import { parseHumanRecordComment } from "./humanRecords.js";
import {
  handleDeployComment,
  integrationCommit,
  parseDeployComment,
  trelloRecordRef,
  type DeploymentOutcome,
  type IntegrationReads,
  type ReleaseDeps,
} from "./releaseStage.js";
import { machineRecordComment, parseMachineRecord } from "./stageRecords.js";

const validator = createLifecycleValidator(config.lifecycleSchemaPath);
const repo = "https://github.com/example/mealflow";
const sha = (c: string) => c.repeat(40);
const workItem = { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 3, trello_card_id: "card-1" };
const OWNER = "owner-1";
const CANDIDATE = sha("c");
const EVALUATED = sha("e");
const MERGE = sha("f");
const MAIN_BEFORE = sha("9");

function card(list = "list-release"): TrelloCard {
  return {
    id: "card-1",
    idBoard: "board-1",
    idShort: 1,
    name: "Weekly plan",
    idList: list,
    shortLink: "x",
    url: "u",
    desc: writeFreezeProjection("", {
      state: "Active",
      tuple: {
        productId: "MF",
        intentId: "INT-MF-0042",
        intentVersion: 3,
        intentCommit: sha("a"),
        intentSha256: "1".repeat(64),
        policyProfileId: "MF-DEFAULT",
        policyProfileVersion: "1",
        policyProfileCommit: sha("a"),
        policyProfileSha256: "2".repeat(64),
        cardId: "card-1",
        freezeEventId: "freeze-1",
        authorizedBy: OWNER,
        frozenAt: "2026-10-27T11:00:00.000Z",
      },
    }),
  };
}

const approvalRecord = {
  schema_version: "1.0",
  work_item: workItem,
  candidate: { repository: repo, commit_sha: CANDIDATE },
  evidence: {
    repository: repo,
    commit_sha: sha("d"),
    path: ".agent/work/INT-MF-0042/evidence-package/x.json",
    sha256: "5".repeat(64),
  },
  evaluation: {
    repository: repo,
    commit_sha: EVALUATED,
    path: ".agent/work/INT-MF-0042/evaluation-package/inv-eval.json",
    sha256: "6".repeat(64),
  },
  decision: "approved_for_integration_and_release",
  authorized_by: OWNER,
  recorded_at: "2026-11-01T09:00:00.000Z",
  rationale: "QA checked the plan view.",
};

function evaluationComments(): TrelloComment[] {
  const freeze = {
    schema_version: "1.0",
    event_id: "freeze-1",
    event_type: "activated",
    work_item: workItem,
    intent: {
      repository: "https://github.com/example/intent-backlog",
      commit_sha: sha("a"),
      path: "i.md",
      sha256: "1".repeat(64),
    },
    policy_profile_id: "MF-DEFAULT",
    policy_profile_version: "1",
    policy_profile: {
      repository: "https://github.com/example/intent-backlog",
      commit_sha: sha("a"),
      path: "p.md",
      sha256: "2".repeat(64),
    },
    authorized_by: OWNER,
    recorded_at: "2026-10-27T11:00:00.000Z",
  };
  const invocation = {
    schema_version: "1.1",
    invocation_id: "inv-eval",
    trigger_event_id: "evt",
    stage: "evaluation",
    work_item: workItem,
    freeze_activation: freeze,
    input_artifacts: [approvalRecord.evidence],
    target: { repository: repo, commit_sha: sha("d") },
    workspace_ref: "work/INT-MF-0042",
    read_paths: ["."],
    write_paths: [".agent/work/INT-MF-0042/evaluation-package"],
  };
  const result = {
    schema_version: "1.0",
    invocation_id: "inv-eval",
    stage: "evaluation",
    work_item: workItem,
    status: "pass",
    output_artifacts: [approvalRecord.evaluation],
    candidate: { repository: repo, commit_sha: CANDIDATE },
    summary: "Evaluated.",
  };
  return [
    {
      id: "e1",
      date: "2026-11-01T00:50:00.000Z",
      data: { text: machineRecordComment("stage-invocation", invocation, "") },
    },
    { id: "e2", date: "2026-11-01T00:59:00.000Z", data: { text: machineRecordComment("stage-result", result, "") } },
  ];
}

const approvalComment: TrelloComment = {
  id: "approval-1",
  date: "2026-11-01T09:00:01.000Z",
  idMemberCreator: OWNER,
  data: { text: humanRecordComment("HumanApprovalRecord", approvalRecord, "Human Approval Record.") },
};

const DEPLOY_TEXT = "Deploy: production\nRationale: Weekend menu planning needs it.\nQA passed.";

function deployComment(text = DEPLOY_TEXT, author = OWNER): TrelloComment {
  return { id: "deploy-c1", date: "2026-11-01T20:00:00.000Z", idMemberCreator: author, data: { text } };
}

const event: CardCommentEvent = {
  event_id: "deploy-c1",
  board_id: "board-1",
  card_id: "card-1",
  comment_id: "deploy-c1",
  actor_id: OWNER,
  occurred_at: "2026-11-01T20:00:00.000Z",
  text: DEPLOY_TEXT,
};

function goodReads(overrides: Partial<IntegrationReads> = {}): IntegrationReads {
  const pull: MergedPullRequest = {
    number: 7,
    headSha: EVALUATED,
    mergeCommitSha: MERGE,
    mergedAt: "2026-11-01T19:00:00Z",
  };
  return {
    mergedPulls: async () => [pull],
    parentsOf: async () => [MAIN_BEFORE, EVALUATED],
    onBranch: async () => true,
    ...overrides,
  };
}

function report(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1.0",
    deployment_id: "deploy-deploy-c1",
    status,
    actions: ["Built image mealflow:ffffffffffff."],
    verification: [
      {
        name: "health",
        outcome: status === "released" ? "passed" : "failed",
        observed_at: "2026-11-01T20:02:00.000Z",
        summary: "HTTP check.",
      },
    ],
    summary: `${status} summary.`,
    ...extra,
  };
}

function harness(options: {
  comments?: TrelloComment[];
  card?: TrelloCard;
  reads?: IntegrationReads;
  outcome?: DeploymentOutcome;
  deployConfigured?: boolean;
}) {
  const comments = [...(options.comments ?? [...evaluationComments(), approvalComment, deployComment()])];
  const posted: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const deps: ReleaseDeps = {
    getCard: async () => options.card ?? card(),
    getCardComments: async () => comments,
    commentOnCard: async (_id, text) => {
      posted.push(text);
      comments.push({
        id: `posted-${posted.length}`,
        date: new Date(Date.parse("2026-11-01T21:00:00Z") + posted.length).toISOString(),
        idMemberCreator: OWNER,
        data: { text },
      });
    },
    productOwners: async () => [OWNER],
    integrationReads: async () => options.reads ?? goodReads(),
    deploy: async (request) => {
      requests.push(request);
      return options.outcome ?? { report: report("released"), error: null };
    },
    deployConfigured: options.deployConfigured ?? true,
    releaseListId: "list-release",
    boardId: "board-1",
    integrationBranch: "main",
    validator,
    now: () => new Date("2026-11-01T20:05:00.000Z"),
  };
  return { deps, posted, requests, comments };
}

function releaseRecordIn(posted: string[]): Record<string, unknown> | null {
  for (const text of posted) {
    const record = parseMachineRecord(text, "release-record");
    if (record) return record;
  }
  return null;
}

test("a Deploy comment needs the environment on the first line and a written rationale", () => {
  assert.deepEqual(parseDeployComment(DEPLOY_TEXT), {
    ok: true,
    value: { environment: "production", rationale: "Weekend menu planning needs it.\nQA passed." },
  });
  assert.equal(parseDeployComment("deploy:  Production \r\nReason: fine").ok, true);
  const noRationale = parseDeployComment("Deploy: production");
  assert.match(!noRationale.ok ? noRationale.problem : "", /Rationale:/);
  const noEnvironment = parseDeployComment("Deploy:\nRationale: x");
  assert.match(!noEnvironment.ok ? noEnvironment.problem : "", /Deploy: <environment>/);
  assert.equal(parseDeployComment("Deploy: prod uction\nRationale: x").ok, false);
});

test("a Trello record reference fingerprints the comment's exact text and names its author", () => {
  const ref = trelloRecordRef("board-1", "card-1", deployComment());
  assert.deepEqual(ref, {
    board_id: "board-1",
    card_id: "card-1",
    comment_id: "deploy-c1",
    author_id: OWNER,
    content_sha256: createHash("sha256").update(DEPLOY_TEXT, "utf8").digest("hex"),
  });
  assert.deepEqual(validator.validate("TrelloRecordRef", ref).errors, []);
});

test("the merge must be the evaluated commit, merged with a merge commit, and on main", async () => {
  const ok = await integrationCommit(goodReads(), "work/INT-MF-0042", "main", EVALUATED);
  assert.deepEqual(ok, { ok: true, value: { sha: MERGE, pull: 7 } });

  const none = await integrationCommit(goodReads({ mergedPulls: async () => [] }), "work/x", "main", EVALUATED);
  assert.match(!none.ok ? none.problem : "", /No merged pull request from `work\/x` into `main`/);

  const changed = await integrationCommit(
    goodReads({ mergedPulls: async () => [{ number: 7, headSha: sha("1"), mergeCommitSha: MERGE, mergedAt: "x" }] }),
    "work/x",
    "main",
    EVALUATED,
  );
  assert.match(!changed.ok ? changed.problem : "", /not the evaluated and approved .* needs a new evaluation/);

  const squashed = await integrationCommit(
    goodReads({ parentsOf: async () => [MAIN_BEFORE] }),
    "work/x",
    "main",
    EVALUATED,
  );
  assert.match(!squashed.ok ? squashed.problem : "", /not merged with a merge commit/);

  const gone = await integrationCommit(goodReads({ onBranch: async () => false }), "work/x", "main", EVALUATED);
  assert.match(!gone.ok ? gone.problem : "", /no longer on `main`/);
});

test("an authorized Deploy comment is recorded, deployed, and turned into a released Release Record", async () => {
  const { deps, posted, requests } = harness({});
  await handleDeployComment(event, deps);

  const authorization = parseHumanRecordComment(posted[0]);
  assert.equal(authorization?.definition, "DeploymentAuthorizationRecord");
  const record = authorization?.record as Record<string, unknown>;
  assert.deepEqual(validator.validate("DeploymentAuthorizationRecord", record).errors, []);
  assert.deepEqual(record.integration, { repository: repo, commit_sha: MERGE });
  assert.equal(record.environment, "production");
  assert.equal(record.authorized_by, OWNER);
  assert.equal(record.rationale, "Weekend menu planning needs it.\nQA passed.");
  assert.deepEqual(record.authorization_ref, trelloRecordRef("board-1", "card-1", deployComment()));
  assert.match(
    posted[0],
    /Deployment Authorization Record: \*\*production\*\* for merge commit `ffffffffffff` \(pull request #7\)/,
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].deployment_id, "deploy-deploy-c1");
  assert.deepEqual(requests[0].deployment_authorization, record);

  const release = releaseRecordIn(posted);
  assert.ok(release);
  assert.deepEqual(validator.validate("ReleaseRecord", release).errors, []);
  assert.equal(release.status, "released");
  assert.deepEqual(release.candidate, { repository: repo, commit_sha: CANDIDATE });
  assert.deepEqual(release.integration, { repository: repo, commit_sha: MERGE });
  assert.deepEqual(release.approval_record, trelloRecordRef("board-1", "card-1", approvalComment));
  assert.deepEqual(release.deployment_authorization, record);
  assert.equal(release.recorded_at, "2026-11-01T20:05:00.000Z");
  assert.match(
    posted.at(-1) ?? "",
    /Released: `ffffffffffff` is running in production and healthy\. .*Move the card to Production Observation/,
  );
});

test("a rollback is recorded with its facts and keeps the card in Release", async () => {
  const { deps, posted } = harness({
    outcome: { report: report("rolled_back", { rollback: "Rolled back to mealflow:aaaa; HTTP 200." }), error: null },
  });
  await handleDeployComment(event, deps);
  const release = releaseRecordIn(posted);
  assert.equal(release?.status, "rolled_back");
  assert.equal(release?.rollback, "Rolled back to mealflow:aaaa; HTTP 200.");
  assert.match(posted.at(-1) ?? "", /Rolled back: .*stays in Release/);
});

test("a deploy service that gives no report leaves no Release Record and says the outcome is unknown", async () => {
  const { deps, posted } = harness({
    outcome: { report: null, error: "The deploy service service no longer knows deployment x" },
  });
  await handleDeployComment(event, deps);
  assert.equal(releaseRecordIn(posted), null);
  assert.match(posted.at(-1) ?? "", /did not return a result: .* The outcome is unknown/);
});

test("every refusal is explained and nothing is deployed", async () => {
  const cases: [string, Parameters<typeof harness>[0], RegExp][] = [
    ["not in Release", { card: card("list-human") }, /the card is not in Release/],
    [
      "not an owner",
      { comments: [...evaluationComments(), approvalComment, deployComment(DEPLOY_TEXT, "stranger")] },
      /only an authorized product owner/,
    ],
    [
      "no rationale",
      { comments: [...evaluationComments(), approvalComment, deployComment("Deploy: production")] },
      /written reason on a line that starts with `Rationale:`/,
    ],
    ["no deploy service", { deployConfigured: false }, /no deploy service is configured/],
    [
      "no approval",
      { comments: [...evaluationComments(), deployComment()] },
      /not an approval for integration and release/,
    ],
    ["squash merge", { reads: goodReads({ parentsOf: async () => [MAIN_BEFORE] }) }, /not merged with a merge commit/],
  ];
  for (const [name, options, reason] of cases) {
    const { deps, posted, requests } = harness(options);
    await handleDeployComment(event, deps);
    assert.equal(requests.length, 0, name);
    assert.match(posted.join("\n"), reason, name);
    assert.ok(
      posted.every((text) => text.startsWith("⛔ Not deployed:")),
      name,
    );
  }
});

test("a newer rework decision supersedes the approval", async () => {
  const rework = {
    ...approvalComment,
    id: "approval-2",
    date: "2026-11-01T10:00:00.000Z",
    data: {
      text: humanRecordComment(
        "HumanApprovalRecord",
        { ...approvalRecord, decision: "return_to_execution" },
        "Rework.",
      ),
    },
  };
  const { deps, posted, requests } = harness({
    comments: [...evaluationComments(), approvalComment, rework, deployComment()],
  });
  await handleDeployComment(event, deps);
  assert.equal(requests.length, 0);
  assert.match(posted[0], /not an approval for integration and release/);
});

test("a repeated webhook, an edited-away comment, or an already released candidate does not deploy again", async () => {
  const first = harness({});
  await handleDeployComment(event, first.deps);
  await handleDeployComment(event, first.deps);
  assert.equal(first.requests.length, 1);

  const edited = harness({ comments: [...evaluationComments(), approvalComment, deployComment("Never mind.")] });
  await handleDeployComment(event, edited.deps);
  assert.deepEqual(edited.posted, []);

  const again = harness({ comments: first.comments });
  await handleDeployComment({ ...event, comment_id: "deploy-c2" }, again.deps);
  assert.equal(again.requests.length, 0);
});

test("a new Deploy comment after a failed release tries again", async () => {
  const failed = harness({ outcome: { report: report("failed"), error: null } });
  await handleDeployComment(event, failed.deps);
  const retryComment = { ...deployComment(), id: "deploy-c2", date: "2026-11-01T22:00:00.000Z" };
  failed.comments.push(retryComment);
  const retry = harness({ comments: failed.comments });
  await handleDeployComment({ ...event, comment_id: "deploy-c2" }, retry.deps);
  assert.equal(retry.requests.length, 1);
  assert.equal(retry.requests[0].deployment_id, "deploy-deploy-c2");
});
