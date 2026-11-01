// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Records the Spec Acceptance Record when the product owner moves a card from Spec & Design to Execution.
// ABOUTME: The move is the decision; the Conductor binds it to the latest validated spec_ready artifacts.
import type { LifecycleValidator } from "../contracts/lifecycle.js";
import type { TrelloCard, TrelloComment } from "../trello/client.js";
import { activeFreezeForCard } from "./freezeState.js";
import { HUMAN_RECORD_MARKER } from "./humanRecords.js";
import { newestFirst, parseMachineRecord } from "./stageRecords.js";

export interface SpecAcceptanceCheck {
  record: Record<string, unknown>;
  expectedSpec: Record<string, unknown>;
  expectedWorkContract: Record<string, unknown>;
  expectedTargetCommit: string;
}

export interface SpecAcceptanceInput {
  card: TrelloCard;
  comments: TrelloComment[];
  /** Trello member who moved the card; becomes `authorized_by`. */
  actorId: string;
  /** Time of the move; becomes `recorded_at`. */
  recordedAt: string;
  validator: LifecycleValidator;
  /** Verifies authorization, freeze, and exact artifact bytes; returns blocking issues. */
  verify: (check: SpecAcceptanceCheck) => Promise<string[]>;
}

export type SpecAcceptanceOutcome =
  | {
      accepted: true;
      record: Record<string, unknown>;
      freezeActivation: Record<string, unknown>;
      workspaceRef: string;
      targetCommit: string;
    }
  | { accepted: false; reason: string };

function artifactEndingWith(outputs: unknown, name: string): Record<string, unknown> | undefined {
  if (!Array.isArray(outputs)) return undefined;
  return outputs.find(
    (artifact): artifact is Record<string, unknown> =>
      !!artifact &&
      typeof artifact === "object" &&
      String((artifact as Record<string, unknown>).path).endsWith(`/${name}`),
  );
}

export function specAcceptanceComment(record: Record<string, unknown>): string {
  const spec = record.spec as Record<string, unknown>;
  const contract = record.work_contract as Record<string, unknown>;
  return (
    `${HUMAN_RECORD_MARKER}${JSON.stringify({ definition: "SpecAcceptanceRecord", record })} -->\n` +
    `✅ Spec Acceptance Record: \`${spec.path}\` (SHA-256 \`${spec.sha256}\`) and \`${contract.path}\` ` +
    `(SHA-256 \`${contract.sha256}\`) at commit \`${spec.commit_sha}\` were accepted for Execution.`
  );
}

/** Builds and verifies the Spec Acceptance Record for a validated Spec & Design -> Execution move. */
export async function recordSpecAcceptance(input: SpecAcceptanceInput): Promise<SpecAcceptanceOutcome> {
  const { card, validator } = input;
  const freeze = activeFreezeForCard(card);
  if (!freeze) return { accepted: false, reason: "The card does not have an active Prioritized freeze." };

  const ordered = newestFirst(input.comments);
  const latest = ordered
    .map((comment) => parseMachineRecord(comment.data?.text ?? "", "stage-result"))
    .find((result) => {
      if (!result || result.stage !== "spec_design" || !validator.validate("StageResult", result).valid) return false;
      const item = result.work_item as Record<string, unknown>;
      return item.trello_card_id === card.id;
    });
  if (!latest) return { accepted: false, reason: "No validated Spec & Design result is recorded on this card." };
  if (latest.status !== "spec_ready") {
    return {
      accepted: false,
      reason: `The latest Spec & Design result is \`${String(latest.status)}\`, not \`spec_ready\`; there is no ready spec to accept.`,
    };
  }
  const item = latest.work_item as Record<string, unknown>;
  if (
    item.product_id !== freeze.tuple.productId ||
    item.intent_id !== freeze.tuple.intentId ||
    item.intent_version !== freeze.tuple.intentVersion
  ) {
    return {
      accepted: false,
      reason: "The latest spec_ready result does not belong to the active Prioritized freeze.",
    };
  }

  const spec = artifactEndingWith(latest.output_artifacts, "spec.md");
  const workContract = artifactEndingWith(latest.output_artifacts, "work-contract.yaml");
  if (!spec || !workContract) {
    return {
      accepted: false,
      reason: "The latest spec_ready result does not reference both spec.md and work-contract.yaml.",
    };
  }

  const invocation = ordered
    .map((comment) => parseMachineRecord(comment.data?.text ?? "", "stage-invocation"))
    .find((entry) => entry?.invocation_id === latest.invocation_id);
  if (!invocation || !validator.validate("StageInvocation", invocation).valid) {
    return { accepted: false, reason: "The StageInvocation for the latest spec_ready result is missing or invalid." };
  }
  const invocationItem = invocation.work_item as Record<string, unknown>;
  if (invocationItem.trello_card_id !== card.id || invocationItem.intent_id !== freeze.tuple.intentId) {
    return { accepted: false, reason: "The latest spec_ready StageInvocation does not belong to this card's freeze." };
  }
  const target = invocation.target as Record<string, unknown>;

  const record = {
    schema_version: "1.0",
    work_item: item,
    decision: "accepted_for_execution",
    authorized_by: input.actorId,
    recorded_at: input.recordedAt,
    spec,
    work_contract: workContract,
  };
  const issues = await input.verify({
    record,
    expectedSpec: spec,
    expectedWorkContract: workContract,
    expectedTargetCommit: String(target.commit_sha ?? ""),
  });
  if (issues.length > 0) return { accepted: false, reason: issues.join("; ") };

  return {
    accepted: true,
    record,
    freezeActivation: invocation.freeze_activation as Record<string, unknown>,
    workspaceRef: String(invocation.workspace_ref),
    targetCommit: String(target.commit_sha),
  };
}
