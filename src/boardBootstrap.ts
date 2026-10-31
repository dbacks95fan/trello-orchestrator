// ABOUTME: Reconciles a Trello board to the approved SDLC lists while preserving existing work.
export interface BoardList {
  id: string;
  name: string;
  pos: number;
}

export interface BoardClient {
  getLists(forceRefresh?: boolean): Promise<BoardList[]>;
  createList(name: string, pos?: "top" | "bottom" | number): Promise<BoardList>;
  updateListPosition(listId: string, pos: number): Promise<BoardList>;
}

export interface BoardBootstrapPlan {
  canonicalListNames: readonly string[];
  existingListNames: readonly string[];
  missingListNames: readonly string[];
  unexpectedListNames: readonly string[];
  duplicateListNames: readonly string[];
  requiresReview: boolean;
}

export interface BoardBootstrapResult extends BoardBootstrapPlan {
  applied: boolean;
  createdListNames: readonly string[];
  repositionedListNames: readonly string[];
  finalListNames?: readonly string[];
}

export class BoardBootstrapError extends Error {}

/** Produces a non-mutating reconciliation plan for one board and one lifecycle template. */
export function planBoardBootstrap(
  lists: readonly BoardList[],
  canonicalListNames: readonly string[],
): BoardBootstrapPlan {
  const names = lists.map((list) => list.name);
  const duplicateListNames = names
    .filter((name, index) => names.indexOf(name) !== index)
    .filter((name, index, all) => all.indexOf(name) === index);
  const canonicalNames = new Set(canonicalListNames);
  const missingListNames = canonicalListNames.filter((name) => !names.includes(name));
  const unexpectedListNames = names.filter((name) => !canonicalNames.has(name));

  return {
    canonicalListNames: [...canonicalListNames],
    existingListNames: names,
    missingListNames,
    unexpectedListNames,
    duplicateListNames,
    requiresReview: duplicateListNames.length > 0 || unexpectedListNames.length > 0,
  };
}

function hasCanonicalOrder(lists: readonly BoardList[], canonicalListNames: readonly string[]): boolean {
  return (
    lists.length === canonicalListNames.length && lists.every((list, index) => list.name === canonicalListNames[index])
  );
}

/** Applies a reviewed plan only when every existing list has an unambiguous template mapping. */
export async function bootstrapBoard(
  client: BoardClient,
  canonicalListNames: readonly string[],
  apply: boolean,
): Promise<BoardBootstrapResult> {
  const before = await client.getLists(true);
  const plan = planBoardBootstrap(before, canonicalListNames);
  if (!apply) return { ...plan, applied: false, createdListNames: [], repositionedListNames: [] };

  if (plan.requiresReview) {
    throw new BoardBootstrapError(
      `Board has lists that cannot be reconciled safely: ${[...plan.duplicateListNames, ...plan.unexpectedListNames].join(", ")}.`,
    );
  }

  const createdListNames: string[] = [];
  for (const name of plan.missingListNames) {
    await client.createList(name, "bottom");
    createdListNames.push(name);
  }

  let current = await client.getLists(true);
  const afterCreationPlan = planBoardBootstrap(current, canonicalListNames);
  if (afterCreationPlan.requiresReview || afterCreationPlan.missingListNames.length > 0) {
    throw new BoardBootstrapError("Board changed while it was being provisioned; no list positions were updated.");
  }

  const repositionedListNames: string[] = [];
  for (let index = 0; index < canonicalListNames.length; index += 1) {
    const expectedName = canonicalListNames[index];
    if (current[index]?.name === expectedName) continue;
    const list = current.find((entry) => entry.name === expectedName);
    if (!list) throw new BoardBootstrapError(`Required list disappeared during provisioning: ${expectedName}.`);
    await client.updateListPosition(list.id, index + 1);
    repositionedListNames.push(expectedName);
    current = await client.getLists(true);
  }

  const finalLists = await client.getLists(true);
  if (!hasCanonicalOrder(finalLists, canonicalListNames)) {
    throw new BoardBootstrapError("Board list order could not be verified after provisioning.");
  }

  return {
    ...planBoardBootstrap(finalLists, canonicalListNames),
    applied: true,
    createdListNames,
    repositionedListNames,
    finalListNames: finalLists.map((list) => list.name),
  };
}
