// ABOUTME: Unit tests for mapping a Spec & Design Agent result to a board destination and comment.
import assert from "node:assert/strict";
import test from "node:test";
import type { SpecDesignResult } from "../specDesignAgent/runSpecDesignAgent.js";
import { formatUsage, routeSpecResult } from "./specRouting.js";

function run(result: Record<string, unknown> | null, extra: Partial<SpecDesignResult> = {}): SpecDesignResult {
  return { exitCode: 0, result, rawStdout: "", rawStderr: "", timedOut: false, ...extra };
}

test("spec_ready remains in Spec & Design for human review and cites the committed spec", () => {
  const route = routeSpecResult(
    run({
      status: "spec_ready",
      summary: "Specification covers the weekly planner outcome.",
      branch: "work/INT-MF-0042",
      specPath: ".agent/work/INT-MF-0042/spec.md",
      specCommit: "f".repeat(40),
      specVersion: 1,
      nonBlockingConcerns: ["Nutrition targets are assumed, not specified."],
    }),
  );
  assert.equal(route.destination, null);
  assert.match(route.comment, /ready for human review/i);
  assert.match(route.comment, /\.agent\/work\/INT-MF-0042\/spec\.md/);
  assert.match(route.comment, /Nutrition targets are assumed/);
  assert.match(route.comment, /human reviews/i);
});

test("needs_decision remains in Spec & Design with the itemised brief", () => {
  const route = routeSpecResult(
    run({
      status: "needs_decision",
      summary: "A storage boundary decision is required.",
      humanDecisions: [
        {
          question: "Which service owns meal-plan persistence?",
          impact: "Determines the affected bounded context and data model.",
          options: ["Reuse the recipe service", "Introduce a planner service"],
          minimumAuthority: "Product engineering lead",
        },
      ],
    }),
  );
  assert.equal(route.destination, null);
  assert.match(route.comment, /Which service owns meal-plan persistence\?/);
  assert.match(route.comment, /Reuse the recipe service/);
  assert.match(route.comment, /Product engineering lead/);
});

test("blocked keeps the card in place and lists blocking concerns", () => {
  const route = routeSpecResult(
    run({ status: "blocked", summary: "Frozen intent hash mismatch.", blockingConcerns: ["INTENT_MUTATED"] }),
  );
  assert.equal(route.destination, null);
  assert.match(route.comment, /blocked/i);
  assert.match(route.comment, /INTENT_MUTATED/);
});

test("failed keeps the card in place and explains retry", () => {
  const route = routeSpecResult(run({ status: "failed", summary: "Provider timeout." }, { exitCode: 30 }));
  assert.equal(route.destination, null);
  assert.match(route.comment, /failed/i);
  assert.match(route.comment, /back into Spec & Design/);
});

test("a failed run reports why it failed, not just that it did", () => {
  const route = routeSpecResult(
    run(
      {
        status: "failed",
        summary: "The generated specification did not meet the structural contract.",
        blockingConcerns: [
          "spec.md is missing required section: Validation strategy",
          "section 'Risks and unresolved decisions' contains an unresolved TODO/decision marker",
        ],
      },
      { exitCode: 30 },
    ),
  );
  assert.match(route.comment, /What failed/);
  assert.match(route.comment, /missing required section: Validation strategy/);
  assert.match(route.comment, /unresolved TODO\/decision marker/);
});

test("an unparseable run keeps the card in place and points at the container", () => {
  const route = routeSpecResult(run(null, { exitCode: 1, rawStderr: "Traceback: boom" }));
  assert.equal(route.destination, null);
  assert.match(route.comment, /no parseable result/i);
  assert.match(route.comment, /Docker is running/);
  assert.match(route.comment, /Traceback: boom/);
});

test("a timed-out container keeps the card in place and says so", () => {
  const route = routeSpecResult(run(null, { exitCode: null, timedOut: true, rawStderr: "still generating" }));
  assert.equal(route.destination, null);
  assert.match(route.comment, /time budget/i);
  assert.match(route.comment, /still generating/);
});

test("an unknown status is surfaced without moving the card", () => {
  const route = routeSpecResult(run({ status: "surprise", summary: "n/a" }));
  assert.equal(route.destination, null);
  assert.match(route.comment, /unrecognised status/i);
});

test("formatUsage renders tokens, cache, turns, and cost", () => {
  const line = formatUsage({
    inputTokens: 12000,
    outputTokens: 3400,
    cacheReadTokens: 800,
    cacheCreationTokens: 200,
    totalTokens: 16400,
    turns: 4,
    costUsd: 0.1875,
  });
  assert.match(line, /16,400 tokens/);
  assert.match(line, /12,000 in \/ 3,400 out \/ 800 cached/);
  assert.match(line, /across 4 turns/);
  assert.match(line, /\$0\.19/);
});

test("formatUsage keeps sub-cent runs from reading as free", () => {
  assert.match(
    formatUsage({ totalTokens: 900, inputTokens: 800, outputTokens: 100, turns: 1, costUsd: 0.0031 }),
    /\$0\.0031/,
  );
});

test("formatUsage returns nothing when the provider reports no usage", () => {
  assert.equal(formatUsage(undefined), "");
  assert.equal(formatUsage({}), "");
  assert.equal(formatUsage([1, 2]), "");
});

test("a spec_ready comment reports what the run cost", () => {
  const route = routeSpecResult(
    run({
      status: "spec_ready",
      summary: "ok",
      branch: "work/INT-MF-0042",
      specPath: ".agent/work/INT-MF-0042/spec.md",
      specCommit: "f".repeat(40),
      specVersion: 1,
      nonBlockingConcerns: [],
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 1200,
        turns: 2,
        costUsd: 0.05,
      },
    }),
  );
  assert.equal(route.destination, null);
  assert.match(route.comment, /🧾 Usage: 1,200 tokens/);
  assert.match(route.comment, /\$0\.05/);
});

test("a failed run still reports what it cost before failing", () => {
  const route = routeSpecResult(
    run(
      {
        status: "failed",
        summary: "provider timeout",
        usage: { totalTokens: 5000, inputTokens: 4800, outputTokens: 200, turns: 1, costUsd: 0.02 },
      },
      { exitCode: 30 },
    ),
  );
  assert.match(route.comment, /🧾 Usage: 5,000 tokens/);
});
