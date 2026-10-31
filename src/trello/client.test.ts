// ABOUTME: Verifies board setup and ProductConfig 1.1 stage mappings use Trello IDs.
import assert from "node:assert/strict";
import test from "node:test";

test("creates a list with the resolved full board identifier", async () => {
  Object.assign(process.env, {
    TRELLO_API_KEY: "test-key",
    TRELLO_TOKEN: "test-token",
    TRELLO_API_SECRET: "test-secret",
    TRELLO_BOARD_ID: "short-board-id",
    TARGET_REPO: "C:/Repos/PerioVox",
    CODING_AGENT_API_URL: "http://127.0.0.1:8081",
    CODING_AGENT_API_TOKEN: "test-coding-agent-token",
    EVALUATOR_API_URL: "http://127.0.0.1:8080",
    EVALUATOR_API_TOKEN: "test-evaluator-token",
    CALLBACK_URL: "https://example.test",
  });

  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/boards/short-board-id")) {
      return Response.json({ id: "0123456789abcdef01234567" });
    }
    return Response.json({ id: "list-1", name: "New Ideas", pos: 1 });
  };

  try {
    const { createList } = await import("./client.js");
    await createList("New Ideas");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.match(requests[1], /idBoard=0123456789abcdef01234567/);
});

test("uses ProductConfig 1.1 list IDs even when board lists have custom names", async () => {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  const configuredLists = {
    new_ideas: "id-new",
    backlog: "id-backlog",
    prioritized: "id-prioritized",
    spec_design: "id-spec",
    execution: "id-execution",
    evaluation: "id-evaluation",
    human_approval: "id-approval",
    release: "id-release",
    production_observation: "id-observation",
    done: "id-done",
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/boards/short-board-id/lists")) {
      return Response.json(Object.values(configuredLists).map((id) => ({ id, name: `Custom ${id}`, pos: 1 })));
    }
    return Response.json({ id: "0123456789abcdef01234567" });
  };

  try {
    const { getWorkflowListIds } = await import("./client.js");
    const result = await getWorkflowListIds({ schema_version: "1.1", trello_board_id: "0123456789abcdef01234567", trello_lists: configuredLists });
    assert.deepEqual(result, {
      newIdeas: "id-new",
      backlog: "id-backlog",
      prioritized: "id-prioritized",
      specDesign: "id-spec",
      execution: "id-execution",
      evaluation: "id-evaluation",
      humanApproval: "id-approval",
      release: "id-release",
      productionObservation: "id-observation",
      done: "id-done",
    });
    await assert.rejects(
      () => getWorkflowListIds({ schema_version: "1.1", trello_board_id: "0123456789abcdef01234567", trello_lists: { ...configuredLists, done: configuredLists.backlog } }),
      /distinct Trello list ID/,
    );
    await assert.rejects(
      () => getWorkflowListIds({ schema_version: "1.1", trello_board_id: "another-board", trello_lists: configuredLists }),
      /does not match the configured Trello board/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
});
