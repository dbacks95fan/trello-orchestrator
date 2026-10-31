// ABOUTME: Verifies invalid workflow templates cannot be used to mutate a Trello board.
import assert from "node:assert/strict";
import test from "node:test";
import { parseBoardWorkflowTemplate } from "./boardTemplate.js";

test("parses a versioned board template with unique lifecycle lists", () => {
  const template = parseBoardWorkflowTemplate("template_version: 1\nlists:\n  - New Ideas\n  - Backlog\n");
  assert.deepEqual(template.listNames, ["New Ideas", "Backlog"]);
});

test("accepts the current canonical template version", () => {
  const template = parseBoardWorkflowTemplate("template_version: 2\nlists:\n  - New Ideas\n  - Backlog\n");
  assert.equal(template.templateVersion, 2);
});

test("rejects duplicate board list names", () => {
  assert.throws(() => parseBoardWorkflowTemplate("template_version: 1\nlists:\n  - Backlog\n  - Backlog\n"), /unique/);
});
