import express from "express";
import { config, webhookUrl } from "./config.js";
import { createGitHubAppReadToken } from "./githubApp.js";
import {
  ensureWebhook,
  getCard,
  getCardComments,
  getWorkflowListIds,
  resolveBoardId,
  commentOnCard,
  DEPLOY_PREFIX,
  type TrelloCard,
} from "./trello/client.js";
import { verifyTrelloSignature } from "./trello/webhookVerify.js";
import {
  handleCardFreezeRevocation,
  handleCardPrioritized,
  handleCardReadyForAgent,
  handleCardReviewForAgent,
  handleCardRework,
  handleDeployRequest,
  handleHumanApprovalMove,
  isHumanApprovalAction,
  handleCardSpecAndDesign,
} from "./workflow/workflow.js";
import { createLifecycleValidator } from "./contracts/lifecycle.js";
import { boardTransitionFromWebhook, cardCommentFromWebhook } from "./trello/webhookEvent.js";
import { processBoardTransition } from "./workflow/boardTransition.js";
import { resolveSpecRequest } from "./workflow/specRequestFromCard.js";
import { validateSpecAcceptanceRecord } from "./workflow/humanRecords.js";
import { recordSpecAcceptance, specAcceptanceComment } from "./workflow/specAcceptance.js";

const lifecycleValidator = createLifecycleValidator(config.lifecycleSchemaPath);
let configuredBoardId = "";

const app = express();

// Trello signs over the exact raw bytes of the request body — capture them
// before any JSON parsing/re-serialization would alter whitespace/key order.
app.use("/webhooks/trello", express.raw({ type: "*/*" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Trello sends a HEAD request when a webhook is first registered, just to
// confirm the callback URL is reachable. Must return 2xx or registration fails.
app.head("/webhooks/trello", (_req, res) => {
  res.sendStatus(200);
});

app.post("/webhooks/trello", async (req, res) => {
  const rawBody = req.body as Buffer;
  const signature = req.header("X-Trello-Webhook");

  if (!verifyTrelloSignature(rawBody, signature)) {
    console.warn("[trello-orchestrator] Rejected webhook delivery: invalid signature.");
    res.sendStatus(401);
    return;
  }

  // Ack immediately — Trello expects a fast response and may disable the
  // webhook after repeated timeouts. Actual work happens after responding.
  res.sendStatus(200);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    console.warn("[trello-orchestrator] Webhook body was not valid JSON.");
    return;
  }

  // The Release stage starts from an owner's "Deploy:" comment; every other comment is ignored.
  const comment = cardCommentFromWebhook(payload);
  if (comment) {
    if (comment.board_id === configuredBoardId && DEPLOY_PREFIX.test(comment.text)) {
      void handleDeployRequest(comment, async (card) => {
        const resolved = await resolveSpecRequest(card, {
          githubApiBase: config.intentBacklogApiBase,
          intentBacklogReadToken: config.intentBacklogReadToken,
          approvedBy: comment.actor_id,
          approvedAt: comment.occurred_at,
        });
        return resolved.productConfig.authorized_product_owner_ids;
      });
    }
    return;
  }

  const event = boardTransitionFromWebhook(payload);
  if (!event) return;
  void processBoardTransition(event, {
    boardId: configuredBoardId,
    validator: lifecycleValidator,
    getCard,
    getCardComments,
    commentOnCard,
    getProductConfig: async (card: TrelloCard) => {
      const resolved = await resolveSpecRequest(card, {
        githubApiBase: config.intentBacklogApiBase,
        intentBacklogReadToken: config.intentBacklogReadToken,
        approvedBy: event.actor_id,
        approvedAt: event.occurred_at,
      });
      return resolved.productConfig;
    },
    getWorkflowListIds,
    dispatch: async (action, transition, card) => {
      const approval = {
        approvedBy: transition.actor_id,
        approvedAt: transition.occurred_at,
        eventId: transition.event_id,
      };
      switch (action) {
        case "activate_freeze":
          await handleCardPrioritized(card.id, approval);
          return;
        case "revoke_freeze":
          await handleCardFreezeRevocation(card.id, transition.actor_id, transition.occurred_at, transition.event_id);
          return;
        case "start_spec_design":
          handleCardSpecAndDesign(card.id, approval);
          return;
        case "accept_spec": {
          const productConfig = await (async () => {
            const resolved = await resolveSpecRequest(card, {
              githubApiBase: config.intentBacklogApiBase,
              intentBacklogReadToken: config.intentBacklogReadToken,
              approvedBy: transition.actor_id,
              approvedAt: transition.occurred_at,
            });
            return resolved.productConfig;
          })();
          const outcome = await recordSpecAcceptance({
            card,
            comments: await getCardComments(card.id),
            actorId: transition.actor_id,
            recordedAt: transition.occurred_at,
            validator: lifecycleValidator,
            verify: async (check) =>
              validateSpecAcceptanceRecord({
                card,
                actorId: transition.actor_id,
                record: check.record,
                validator: lifecycleValidator,
                productConfig,
                expectedSpec: check.expectedSpec,
                expectedWorkContract: check.expectedWorkContract,
                expectedTargetCommit: check.expectedTargetCommit,
                githubApiBase: config.intentBacklogApiBase,
                intentBacklogReadToken: config.intentBacklogReadToken,
                productRepositoryReadToken: await createGitHubAppReadToken({
                  appId: config.orchestratorGithubAppId,
                  installationId: config.orchestratorGithubAppInstallationId,
                  privateKeyFile: config.orchestratorGithubAppPrivateKeyFile,
                  repositoryUrl: productConfig.target_repository,
                }),
                resolveIntent: resolveSpecRequest,
              }),
          });
          if (!outcome.accepted) {
            await commentOnCard(card.id, `Execution was not started: ${outcome.reason}`);
            return;
          }
          await commentOnCard(card.id, specAcceptanceComment(outcome.record));
          handleCardReadyForAgent(
            card.id,
            outcome.record,
            outcome.workspaceRef,
            outcome.targetCommit,
            outcome.freezeActivation,
          );
          return;
        }
        case "start_evaluation":
          handleCardReviewForAgent(card.id, transition.event_id);
          return;
        case "evaluation_implementation_rework":
          await handleCardRework(card.id, transition.event_id);
          return;
        default:
          if (isHumanApprovalAction(action)) {
            await handleHumanApprovalMove(card.id, action, transition.actor_id, transition.occurred_at);
            return;
          }
          await commentOnCard(
            card.id,
            `${action} was recorded as a board transition. This Orchestrator build does not automate that human-controlled downstream action.`,
          );
      }
    },
  });
});

async function main() {
  // Resolve the board ID for webhook registration. ProductConfig 1.1 supplies
  // the stage-to-list mapping, which is validated against Trello per event.
  // Must be listening BEFORE asking Trello to register the webhook — Trello
  // does an immediate reachability check (a HEAD request) against the callback
  // URL as part of registration, which would fail against a tunnel pointed at
  // a port nothing is serving yet.
  await new Promise<void>((resolvePromise) => {
    app.listen(config.port, () => {
      console.log(`[trello-orchestrator] listening on :${config.port}`);
      resolvePromise();
    });
  });

  const boardRealId = await resolveBoardId();
  configuredBoardId = boardRealId;
  const webhook = await ensureWebhook(webhookUrl, boardRealId);
  console.log(`[trello-orchestrator] Webhook active: ${webhook.id} -> ${webhook.callbackURL}`);
}

main().catch((err) => {
  console.error("[trello-orchestrator] failed to start:", err);
  process.exit(1);
});
