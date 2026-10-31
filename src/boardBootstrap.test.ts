// ABOUTME: Verifies board provisioning creates and orders required lists without touching cards.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BoardBootstrapError,
  bootstrapBoard,
  planBoardBootstrap,
  type BoardClient,
  type BoardList,
} from "./boardBootstrap.js";

class FakeBoardClient implements BoardClient {
  constructor(private lists: BoardList[]) {}

  async getLists(): Promise<BoardList[]> {
    return this.lists.map((list) => ({ ...list }));
  }

  async createList(name: string): Promise<BoardList> {
    const list = { id: `list-${this.lists.length + 1}`, name, pos: this.lists.length + 1 };
    this.lists.push(list);
    return { ...list };
  }

  async updateListPosition(listId: string, pos: number): Promise<BoardList> {
    const index = this.lists.findIndex((list) => list.id === listId);
    if (index < 0) throw new Error(`Unknown list ${listId}`);
    const [list] = this.lists.splice(index, 1);
    this.lists.splice(Math.max(0, Math.min(pos - 1, this.lists.length)), 0, list);
    this.lists.forEach((entry, entryIndex) => {
      entry.pos = entryIndex + 1;
    });
    return { ...list };
  }
}

const lifecycle = ["New Ideas", "Backlog", "Prioritized"];

test("plans missing lists without changing the board", () => {
  const plan = planBoardBootstrap([{ id: "backlog", name: "Backlog", pos: 1 }], lifecycle);
  assert.deepEqual(plan.missingListNames, ["New Ideas", "Prioritized"]);
  assert.equal(plan.requiresReview, false);
});

test("creates missing lists and establishes canonical order", async () => {
  const client = new FakeBoardClient([{ id: "backlog", name: "Backlog", pos: 1 }]);
  const result = await bootstrapBoard(client, lifecycle, true);
  assert.deepEqual(result.createdListNames, ["New Ideas", "Prioritized"]);
  assert.deepEqual(result.finalListNames, lifecycle);
});

test("refuses an unexpected list instead of moving or deleting existing work", async () => {
  const client = new FakeBoardClient([{ id: "legacy", name: "Legacy work", pos: 1 }]);
  await assert.rejects(() => bootstrapBoard(client, lifecycle, true), BoardBootstrapError);
  assert.deepEqual(
    (await client.getLists()).map((list) => list.name),
    ["Legacy work"],
  );
});
