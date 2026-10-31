// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Stores the Orchestrator's current intent-freeze projection on a Trello card.

import type { TrelloCard } from "../trello/client.js";

const MARKER = "<!-- agentic-sdlc-freeze-state ";

export interface FreezeTuple {
  productId: string;
  intentId: string;
  intentVersion: number;
  intentCommit: string;
  intentSha256: string;
  policyProfileId: string;
  policyProfileVersion: string;
  policyProfileCommit: string;
  policyProfileSha256: string;
  cardId: string;
  freezeEventId?: string;
  authorizedBy: string;
  frozenAt: string;
}

export interface FreezeProjection {
  state: "Active" | "Revoked";
  tuple: FreezeTuple;
  revokedAt?: string;
  revokedBy?: string;
}

export function readFreezeProjection(desc: string): FreezeProjection | null {
  const match = desc.match(/<!-- agentic-sdlc-freeze-state ([\s\S]*?) -->/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]) as FreezeProjection;
    if ((value.state !== "Active" && value.state !== "Revoked") || !value.tuple?.intentId) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeFreezeProjection(desc: string, projection: FreezeProjection): string {
  const marker = `${MARKER}${JSON.stringify(projection)} -->`;
  const withoutMarker = desc.replace(/\n?<!-- agentic-sdlc-freeze-state [\s\S]*? -->\n?/g, "\n").trimEnd();
  return withoutMarker
    ? `${withoutMarker}\n\nFreeze State: ${projection.state}\n${marker}`
    : `Freeze State: ${projection.state}\n${marker}`;
}

export function activeFreezeForCard(card: TrelloCard): FreezeProjection | null {
  const projection = readFreezeProjection(card.desc ?? "");
  return projection?.state === "Active" && projection.tuple.cardId === card.id ? projection : null;
}
