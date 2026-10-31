// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Maps configured Trello list IDs to the canonical in-order workflow transitions.
import type { WorkflowListIds } from "../trello/client.js";

export type WorkflowStage = keyof WorkflowListIds;
export type TransitionAction =
  | "capture_to_backlog"
  | "refine_in_new_ideas"
  | "activate_freeze"
  | "start_spec_design"
  | "accept_spec"
  | "start_execution"
  | "start_evaluation"
  | "evaluation_pass"
  | "evaluation_implementation_rework"
  | "evaluation_spec_rework"
  | "human_approve_release"
  | "human_rework_execution"
  | "human_rework_spec"
  | "human_stop"
  | "release_observation"
  | "release_close"
  | "observation_close"
  | "revoke_freeze"
  | "invalid";

const allowed: Record<string, TransitionAction> = {
  "newIdeas->backlog": "capture_to_backlog",
  "backlog->prioritized": "activate_freeze",
  "prioritized->specDesign": "start_spec_design",
  "specDesign->execution": "accept_spec",
  "execution->evaluation": "start_evaluation",
  "evaluation->humanApproval": "evaluation_pass",
  "evaluation->execution": "evaluation_implementation_rework",
  "evaluation->specDesign": "evaluation_spec_rework",
  "humanApproval->release": "human_approve_release",
  "humanApproval->execution": "human_rework_execution",
  "humanApproval->specDesign": "human_rework_spec",
  "humanApproval->done": "human_stop",
  "release->productionObservation": "release_observation",
  "release->done": "release_close",
  "productionObservation->done": "observation_close",
};

const preExecution = new Set<WorkflowStage>(["prioritized", "specDesign"]);

export interface TransitionResolution {
  from: WorkflowStage | null;
  to: WorkflowStage | null;
  action: TransitionAction;
  requiresProductOwner: boolean;
}

export function resolveTransition(
  fromListId: string,
  toListId: string,
  listIds: WorkflowListIds,
): TransitionResolution {
  const from = (Object.keys(listIds) as WorkflowStage[]).find((stage) => listIds[stage] === fromListId) ?? null;
  const to = (Object.keys(listIds) as WorkflowStage[]).find((stage) => listIds[stage] === toListId) ?? null;
  if (!from || !to) return { from, to, action: "invalid", requiresProductOwner: false };
  if (to === "backlog" || to === "newIdeas") {
    if (preExecution.has(from)) return { from, to, action: "revoke_freeze", requiresProductOwner: true };
    if (from === "backlog" && to === "newIdeas")
      return { from, to, action: "refine_in_new_ideas", requiresProductOwner: true };
  }
  const action = allowed[`${from}->${to}`] ?? "invalid";
  const requiresProductOwner = new Set<TransitionAction>([
    "capture_to_backlog",
    "activate_freeze",
    "accept_spec",
    "evaluation_spec_rework",
    "human_approve_release",
    "human_rework_execution",
    "human_rework_spec",
    "human_stop",
    "release_close",
    "observation_close",
    "revoke_freeze",
  ]).has(action);
  return { from, to, action, requiresProductOwner };
}
