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
  type TrelloCard,
} from "./trello/client.js";
import { verifyTrelloSignature } from "./trello/webhookVerify.js";
import {
  handleCardFreezeRevocation,
  handleCardPrioritized,
  handleCardReadyForAgent,
  handleCardReviewForAgent,
  handleCardSpecAndDesign,
} from "./workflow/workflow.js";
import { createLifecycleValidator } from "./contracts/lifecycle.js";
import { boardTransitionFromWebhook } from "./trello/webhookEvent.js";
import { processBoardTransition } from "./workflow/boardTransition.js";
import { resolveSpecRequest } from "./workflow/specRequestFromCard.js";
import { parseHumanRecordComment, validateSpecAcceptanceRecord } from "./workflow/humanRecords.js";
import { activeFreezeForCard } from "./workflow/freezeState.js";

const lifecycleValidator = createLifecycleValidator(config.lifecycleSchemaPath);
let configuredBoardId = "";

const app = express();

function parseMachineRecord(text: string, kind: "stage-invocation" | "stage-result"): unknown | null {
  const marker = `<!-- agentic-sdlc-${kind} `;
  if (!text.startsWith(marker)) return null;
  const end = text.indexOf(" -->");
  if (end < 0) return null;
  try {
    return JSON.parse(text.slice(marker.length, end));
  } catch {
    return null;
  }
}

function validatorRecord(definition: "StageInvocation" | "StageResult", value: unknown): boolean {
  return lifecycleValidator.validate(definition, value).valid;
}

function sameArtifactReference(left: unknown, right: unknown): boolean {
  if (!left || typeof left !== "object" || !right || typeof right !== "object") return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return a.repository === b.repository && a.commit_sha === b.commit_sha && a.path === b.path && a.sha256 === b.sha256;
}

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
          const comments = await getCardComments(card.id);
          const freeze = activeFreezeForCard(card);
          const records = comments
            .map((comment) => parseHumanRecordComment(comment.data?.text ?? ""))
            .filter(
              (value): value is { definition: string; record: unknown } => value?.definition === "SpecAcceptanceRecord",
            );
          let accepted = false;
          let acceptedRecord: Record<string, unknown> | null = null;
          let acceptedFreezeActivation: Record<string, unknown> | null = null;
          let acceptedWorkspaceRef = "";
          let acceptedTargetCommit = "";
          let rejection = "No SpecAcceptanceRecord comment was found.";
          for (const candidate of records) {
            const acceptance = candidate.record as Record<string, unknown>;
            const acceptedSpec = acceptance?.spec;
            const acceptedContract = acceptance?.work_contract;
            let foundStageOutput = false;
            for (const comment of comments) {
              const stageResult = parseMachineRecord(comment.data?.text ?? "", "stage-result");
              if (!stageResult || !validatorRecord("StageResult", stageResult)) continue;
              const result = stageResult as Record<string, unknown>;
              const item = result.work_item as Record<string, unknown>;
              if (
                result.stage !== "spec_design" ||
                result.status !== "spec_ready" ||
                item.trello_card_id !== card.id ||
                item.product_id !== freeze?.tuple.productId ||
                item.intent_id !== freeze?.tuple.intentId ||
                item.intent_version !== freeze?.tuple.intentVersion
              )
                continue;
              const outputs = result.output_artifacts as Array<Record<string, unknown>>;
              const expectedSpec = outputs.find(
                (artifact) => String(artifact.path).endsWith("/spec.md") || artifact.path === "spec.md",
              );
              const expectedWorkContract = outputs.find(
                (artifact) =>
                  String(artifact.path).endsWith("/work-contract.yaml") || artifact.path === "work-contract.yaml",
              );
              if (
                !expectedSpec ||
                !expectedWorkContract ||
                !sameArtifactReference(acceptedSpec, expectedSpec) ||
                !sameArtifactReference(acceptedContract, expectedWorkContract)
              )
                continue;
              const invocation = comments
                .map((entry) => parseMachineRecord(entry.data?.text ?? "", "stage-invocation"))
                .find((entry) => entry && (entry as Record<string, unknown>).invocation_id === result.invocation_id);
              if (!invocation || !validatorRecord("StageInvocation", invocation)) continue;
              const invocationItem = (invocation as Record<string, unknown>).work_item as Record<string, unknown>;
              const target = (invocation as Record<string, unknown>).target as Record<string, unknown>;
              if (invocationItem.trello_card_id !== card.id || invocationItem.intent_id !== freeze?.tuple.intentId)
                continue;
              foundStageOutput = true;
              const productRepositoryReadToken = await createGitHubAppReadToken({
                appId: config.orchestratorGithubAppId,
                installationId: config.orchestratorGithubAppInstallationId,
                privateKeyFile: config.orchestratorGithubAppPrivateKeyFile,
                repositoryUrl: productConfig.target_repository,
              });
              const issues = await validateSpecAcceptanceRecord({
                card,
                actorId: transition.actor_id,
                record: candidate.record,
                validator: lifecycleValidator,
                productConfig,
                expectedSpec,
                expectedWorkContract,
                expectedTargetCommit: String(target.commit_sha ?? ""),
                githubApiBase: config.intentBacklogApiBase,
                intentBacklogReadToken: config.intentBacklogReadToken,
                productRepositoryReadToken,
                resolveIntent: resolveSpecRequest,
              });
              if (issues.length === 0) {
                accepted = true;
                acceptedRecord = candidate.record as Record<string, unknown>;
                acceptedFreezeActivation = (invocation as Record<string, unknown>).freeze_activation as Record<
                  string,
                  unknown
                >;
                acceptedWorkspaceRef = String((invocation as Record<string, unknown>).workspace_ref);
                acceptedTargetCommit = String(target.commit_sha);
                break;
              }
              rejection = issues.join("; ");
            }
            if (accepted) break;
            if (!foundStageOutput && !rejection.includes("not match"))
              rejection =
                "The acceptance references do not match a validated spec_ready StageResult and StageInvocation.";
          }
          if (!accepted) {
            await commentOnCard(card.id, `Execution was not started: ${rejection}`);
            return;
          }
          handleCardReadyForAgent(
            card.id,
            acceptedRecord!,
            acceptedWorkspaceRef,
            acceptedTargetCommit,
            acceptedFreezeActivation!,
          );
          return;
        }
        case "start_evaluation":
          handleCardReviewForAgent(card.id);
          return;
        default:
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
