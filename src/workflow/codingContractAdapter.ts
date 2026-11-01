// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Converts an accepted canonical Work Contract v3 to the Coding Agent's supported v2 input.
import type { TrelloCard } from "../trello/client.js";
import { createHash } from "node:crypto";
import type { WorkContract } from "./contractFromCard.js";
import type { WorkContractExpectation } from "./workContractV3.js";
import { validateWorkContractV3 } from "./workContractV3.js";
import type { LifecycleValidator } from "../contracts/lifecycle.js";

type CodingGate = "build" | "automated_tests" | "playwright" | "docker_build";

const gateCommands: Record<CodingGate, string> = {
  build: "npm run build",
  automated_tests: "npm run test:server",
  playwright: "npm run test:e2e",
  docker_build: "docker build -t coding-agent-validation:latest .",
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function section(markdown: string, title: string): string {
  const heading = new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "im");
  const match = heading.exec(markdown);
  if (!match) return "";
  const start = match.index + match[0].length;
  const remaining = markdown.slice(start).replace(/^\r?\n/, "");
  const nextHeading = /^##\s+/m.exec(remaining);
  return remaining.slice(0, nextHeading?.index ?? remaining.length).trim();
}

function objectiveFromSpec(markdown: string): string {
  const outcome = section(markdown, "Outcome and scope");
  const objective = outcome
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*+]\s+/, "").trim())
    .filter(Boolean)
    .join(" ");
  if (!objective) throw new Error("The accepted spec is missing its required 'Outcome and scope' content.");
  return objective;
}

function supportedGates(value: unknown): CodingGate[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("The accepted Work Contract has no required validation gates.");
  const gates: CodingGate[] = [];
  for (const item of value) {
    const validation = object(item);
    const name = String(validation?.name ?? "").toLowerCase() as CodingGate;
    const command = String(validation?.command ?? "");
    if (!(name in gateCommands))
      throw new Error(
        `The Coding Agent does not support required validation '${String(validation?.name ?? "missing")}'.`,
      );
    if (gateCommands[name] !== command)
      throw new Error(
        `Validation '${name}' requires '${command}', but the Coding Agent deterministically runs '${gateCommands[name]}'.`,
      );
    if (!gates.includes(name)) gates.push(name);
  }
  return gates;
}

export interface CodingContractAdapterInput {
  card: TrelloCard;
  workContractV3: unknown;
  specMarkdown: string;
  specAcceptance: Record<string, unknown>;
  frozenIntentPath: string;
  frozenIntentBytes: Buffer;
  targetRepository: string;
  targetCommit: string;
  expected: WorkContractExpectation;
  validator: LifecycleValidator;
}

/** Fail closed unless the accepted v3 contract, intent, target, and deterministic gate commands all match. */
export function adaptAcceptedWorkContract(input: CodingContractAdapterInput): WorkContract {
  const issues = validateWorkContractV3(input.workContractV3, input.expected, input.validator);
  if (issues.length) throw new Error(issues.join("; "));
  const v3 = object(input.workContractV3)!;
  const target = object(v3.target)!;
  if (target.repository !== input.targetRepository || target.commit_sha !== input.targetCommit) {
    throw new Error("The accepted Work Contract target does not match the execution branch and base revision.");
  }
  const acceptance = input.specAcceptance;
  const workItem = object(v3.work_item)!;
  const permitted = object(v3.permitted_scope)!;
  const acceptedIntentHash = sha256(input.frozenIntentBytes);
  if (acceptedIntentHash !== input.expected.intentSha256)
    throw new Error("The frozen intent copy on the work branch has changed.");
  const acceptanceWorkItem = object(acceptance.work_item);
  if (
    acceptance.decision !== "accepted_for_execution" ||
    acceptanceWorkItem?.trello_card_id !== input.card.id ||
    acceptance.authorized_by === undefined
  ) {
    throw new Error("The SpecAcceptanceRecord does not authorize this work item for Execution.");
  }
  const acceptanceSpec = object(acceptance.spec);
  if (!acceptanceSpec?.repository || !acceptanceSpec.commit_sha || !acceptanceSpec.path || !acceptanceSpec.sha256) {
    throw new Error("The SpecAcceptanceRecord has no immutable spec reference.");
  }
  const gates = supportedGates(v3.required_validation);
  const criteria = v3.acceptance_criteria as string[];
  const acceptance_criteria: Record<string, string> = {};
  criteria.forEach((criterion, index) => {
    acceptance_criteria[`AC${index + 1}`] = criterion;
  });
  const name = input.card.name;
  const workItemType = name.startsWith("[Epic]")
    ? "Epic"
    : name.startsWith("[Feature]")
      ? "Feature"
      : name.startsWith("[Enabler]")
        ? "Technical Enabler"
        : "User Story";
  const specRepository = String(acceptanceSpec.repository).replace(/\/$/, "");
  const specReviewUrl = `${specRepository}/blob/${String(acceptanceSpec.commit_sha)}/${String(acceptanceSpec.path)}`;
  const constraints = Array.isArray(v3.policy_controls)
    ? v3.policy_controls.map((control) => {
        const entry = object(control)!;
        return `${String(entry.control_id)}: ${String(entry.required_action)}; evidence: ${String(entry.evidence_expected)}`;
      })
    : [];
  return {
    schema_version: 2,
    work_item: `${String(workItem.intent_id)}-v${String(workItem.intent_version)}`,
    objective: objectiveFromSpec(input.specMarkdown),
    acceptance_criteria,
    required_validation: gates,
    ...(Array.isArray(permitted.excluded) && permitted.excluded.length
      ? { non_goals: permitted.excluded.map(String) }
      : {}),
    ...(constraints.length ? { constraints } : {}),
    intent: {
      path: input.frozenIntentPath,
      revision: input.expected.intentCommit,
      sha256: acceptedIntentHash,
      reviewUrl: specReviewUrl,
      status: "Accepted",
      acceptedBy: String(acceptance.authorized_by),
      acceptedAt: String(acceptance.recorded_at),
    },
    board: {
      provider: "trello",
      workItemId: input.card.id,
      workItemUrl: input.card.url,
      workItemType,
    },
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
