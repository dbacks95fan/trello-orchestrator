import { config } from "../config.js";

const BASE = "https://api.trello.com/1";

function authQuery(): string {
  return `key=${encodeURIComponent(config.trelloApiKey)}&token=${encodeURIComponent(config.trelloToken)}`;
}

async function trelloFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}${authQuery()}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Trello API ${init.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface TrelloList {
  id: string;
  name: string;
  pos: number;
}

export interface TrelloCard {
  id: string;
  idBoard?: string;
  idShort: number;
  name: string;
  desc: string;
  idList: string;
  shortLink: string;
  url: string;
}

export interface TrelloComment {
  id: string;
  /** ISO time Trello recorded the comment action. */
  date?: string;
  /** Trello member who wrote the comment. */
  idMemberCreator?: string;
  data: { text?: string };
}

let listCache: TrelloList[] | null = null;

/** Fetches lists from the configured board for setup operations and ID-membership validation. */
export async function getLists(forceRefresh = false): Promise<TrelloList[]> {
  if (listCache && !forceRefresh) return listCache;
  listCache = await trelloFetch<TrelloList[]>(`/boards/${config.boardId}/lists`);
  return listCache;
}

export async function getListIdByName(name: string): Promise<string> {
  let lists = await getLists();
  let matches = lists.filter((l) => l.name === name);
  if (matches.length === 0) {
    lists = await getLists(true); // list may have been created after we cached
    matches = lists.filter((l) => l.name === name);
  }
  if (matches.length === 0) {
    throw new Error(`No list named "${name}" found on board ${config.boardId}`);
  }
  if (matches.length > 1) throw new Error(`Board ${config.boardId} contains more than one list named "${name}".`);
  return matches[0].id;
}

export interface WorkflowListIds {
  newIdeas: string;
  backlog: string;
  prioritized: string;
  specDesign: string;
  execution: string;
  evaluation: string;
  humanApproval: string;
  release: string;
  productionObservation: string;
  done: string;
}

export interface ProductBoardConfig {
  schema_version: "1.1";
  trello_board_id: string;
  trello_lists: {
    new_ideas: string;
    backlog: string;
    prioritized: string;
    spec_design: string;
    execution: string;
    evaluation: string;
    human_approval: string;
    release: string;
    production_observation: string;
    done: string;
  };
}

const stageLabels: Record<keyof WorkflowListIds, string> = {
  newIdeas: "New Ideas",
  backlog: "Backlog",
  prioritized: "Prioritized",
  specDesign: "Spec & Design",
  execution: "Execution",
  evaluation: "Evaluation",
  humanApproval: "Human Approval",
  release: "Release",
  productionObservation: "Production Observation",
  done: "Done",
};

let activeWorkflowListIds: WorkflowListIds | null = null;

/** Validate a product's explicit stage-to-list mapping against the configured Trello board. */
export async function getWorkflowListIds(product: ProductBoardConfig): Promise<WorkflowListIds> {
  const boardId = await resolveBoardId();
  if (product.trello_board_id !== boardId) {
    throw new Error(
      `ProductConfig board ${product.trello_board_id} does not match the configured Trello board ${boardId}.`,
    );
  }
  const ids = Object.values(product.trello_lists);
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("ProductConfig must map every canonical workflow stage to a non-empty Trello list ID.");
  }
  if (new Set(ids).size !== ids.length)
    throw new Error("ProductConfig trello_lists must map each canonical stage to a distinct Trello list ID.");
  const lists = await getLists(true);
  const listIdsOnBoard = new Set(lists.map((list) => list.id));
  const missingIds = ids.filter((id) => !listIdsOnBoard.has(id));
  if (missingIds.length > 0)
    throw new Error(
      `ProductConfig contains Trello list IDs that are not on board ${boardId}: ${missingIds.join(", ")}.`,
    );
  const configured: WorkflowListIds = {
    newIdeas: product.trello_lists.new_ideas,
    backlog: product.trello_lists.backlog,
    prioritized: product.trello_lists.prioritized,
    specDesign: product.trello_lists.spec_design,
    execution: product.trello_lists.execution,
    evaluation: product.trello_lists.evaluation,
    humanApproval: product.trello_lists.human_approval,
    release: product.trello_lists.release,
    productionObservation: product.trello_lists.production_observation,
    done: product.trello_lists.done,
  };
  activeWorkflowListIds = configured;
  return configured;
}

/** Returns the current product board's validated list ID for a canonical stage. */
export function getWorkflowListId(stage: keyof WorkflowListIds): string {
  if (!activeWorkflowListIds)
    throw new Error("No ProductConfig 1.1 workflow list mapping has been validated for this board.");
  return activeWorkflowListIds[stage];
}

export function getWorkflowStageLabel(stage: keyof WorkflowListIds): string {
  return stageLabels[stage];
}

/** Creates a named board list and invalidates the list cache for subsequent validation. */
export async function createList(name: string, pos: "top" | "bottom" | number = "bottom"): Promise<TrelloList> {
  const query = new URLSearchParams({ name, idBoard: await resolveBoardId(), pos: String(pos) });
  const list = await trelloFetch<TrelloList>(`/lists?${query.toString()}`, { method: "POST" });
  listCache = null;
  return list;
}

/** Repositions a board list without altering the cards it contains. */
export async function updateListPosition(listId: string, pos: number): Promise<TrelloList> {
  const query = new URLSearchParams({ pos: String(pos) });
  const list = await trelloFetch<TrelloList>(`/lists/${listId}?${query.toString()}`, { method: "PUT" });
  listCache = null;
  return list;
}

let realBoardIdCache: string | null = null;

/** Webhook creation requires the board's actual 24-char id — a shortLink (fine
 *  for most GET endpoints) is not reliably accepted there. Resolved once and cached. */
export async function resolveBoardId(): Promise<string> {
  if (realBoardIdCache) return realBoardIdCache;
  const board = await trelloFetch<{ id: string }>(`/boards/${config.boardId}?fields=id`);
  realBoardIdCache = board.id;
  return board.id;
}

export async function getCard(cardId: string): Promise<TrelloCard> {
  return trelloFetch<TrelloCard>(`/cards/${cardId}`);
}

export async function getCardComments(cardId: string): Promise<TrelloComment[]> {
  return trelloFetch<TrelloComment[]>(`/cards/${cardId}/actions?filter=commentCard&limit=1000`);
}

export async function getCardsInList(listId: string): Promise<TrelloCard[]> {
  return trelloFetch<TrelloCard[]>(`/lists/${listId}/cards`);
}

/**
 * The only moves the Orchestrator makes itself. It acts with the product owner's Trello identity, so a move it made
 * out of Human Approval, Release, or Production Observation would be indistinguishable from the owner's decision.
 */
const ORCHESTRATOR_ROUTES: ReadonlyArray<readonly [keyof WorkflowListIds, keyof WorkflowListIds]> = [
  ["execution", "evaluation"],
  ["evaluation", "humanApproval"],
  ["evaluation", "execution"],
  ["prioritized", "backlog"],
];

export function isOrchestratorRoute(from: keyof WorkflowListIds, to: keyof WorkflowListIds): boolean {
  return ORCHESTRATOR_ROUTES.some(([routeFrom, routeTo]) => routeFrom === from && routeTo === to);
}

/** Moves the card along an Orchestrator route; returns false, without moving it, if a person has moved it since. */
export async function routeCard(
  cardId: string,
  from: keyof WorkflowListIds,
  to: keyof WorkflowListIds,
): Promise<boolean> {
  if (!isOrchestratorRoute(from, to)) {
    throw new Error(`The Orchestrator does not move cards from ${from} to ${to}; that move is a person's decision.`);
  }
  if ((await getCard(cardId)).idList !== getWorkflowListId(from)) return false;
  await trelloFetch(`/cards/${cardId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idList: getWorkflowListId(to) }),
  });
  return true;
}

export async function updateCardDescription(cardId: string, desc: string): Promise<void> {
  await trelloFetch(`/cards/${cardId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ desc }),
  });
}

/** Human Approval reads the owner's rationale from a comment that starts this way. */
export const RATIONALE_PREFIX = /^\s*(rationale|reason)\s*:\s*/i;
/** A comment that starts this way is the owner's request to deploy the merged candidate. */
export const DEPLOY_PREFIX = /^\s*deploy\s*:/i;

/**
 * True for text that reads as a person's written decision. The Orchestrator comments with the owner's Trello
 * identity, so it never posts one, even when relaying agent text.
 */
export function readsAsHumanDecision(text: string): boolean {
  return RATIONALE_PREFIX.test(text) || DEPLOY_PREFIX.test(text);
}

export async function commentOnCard(cardId: string, text: string): Promise<void> {
  if (readsAsHumanDecision(text)) {
    throw new Error("The Orchestrator does not post comments that read as a person's written decision.");
  }
  await trelloFetch(`/cards/${cardId}/actions/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export interface TrelloWebhook {
  id: string;
  idModel: string;
  callbackURL: string;
  active: boolean;
}

export async function listWebhooks(): Promise<TrelloWebhook[]> {
  return trelloFetch<TrelloWebhook[]>(`/tokens/${config.trelloToken}/webhooks`);
}

export async function createWebhook(callbackURL: string, idModel: string): Promise<TrelloWebhook> {
  return trelloFetch<TrelloWebhook>(`/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "Trello Orchestrator: Agentic SDLC lifecycle transition handler",
      callbackURL,
      idModel,
    }),
  });
}

/** Idempotent: reuses an existing webhook for this board+callback URL if one exists. */
export async function ensureWebhook(callbackURL: string, idModel: string): Promise<TrelloWebhook> {
  const existing = await listWebhooks();
  const match = existing.find((w) => w.idModel === idModel && w.callbackURL === callbackURL);
  if (match) return match;
  return createWebhook(callbackURL, idModel);
}
