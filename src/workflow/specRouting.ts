// ABOUTME: Maps a Spec & Design Agent result to a board destination and a human-readable decision brief.
import type { SpecDesignResult } from "../specDesignAgent/runSpecDesignAgent.js";

export type SpecDestination = null;

export interface SpecRoute {
  destination: SpecDestination;
  comment: string;
}

function list(items: unknown, bullet = "-"): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items.map((item) => `${bullet} ${String(item)}`).join("\n");
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

/** Renders what the run cost so a card is costable without opening the run
 *  record. Absent for providers that do not report usage. */
export function formatUsage(usage: unknown): string {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return "";
  const u = usage as Record<string, unknown>;
  const total = int(u.totalTokens);
  const input = int(u.inputTokens);
  const output = int(u.outputTokens);
  if (total === null && input === null && output === null) return "";

  const parts: string[] = [];
  if (total !== null) parts.push(`${total.toLocaleString("en-US")} tokens`);
  if (input !== null && output !== null) {
    const cacheRead = int(u.cacheReadTokens);
    const detail = [`${input.toLocaleString("en-US")} in`, `${output.toLocaleString("en-US")} out`];
    if (cacheRead) detail.push(`${cacheRead.toLocaleString("en-US")} cached`);
    parts.push(`(${detail.join(" / ")})`);
  }
  const turns = int(u.turns);
  if (turns) parts.push(`across ${turns} turn${turns === 1 ? "" : "s"}`);
  const cost = typeof u.costUsd === "number" && Number.isFinite(u.costUsd) ? u.costUsd : null;
  // Sub-cent runs are common; show enough precision that they don't read as free.
  if (cost !== null) parts.push(`— **$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}**`);
  return `🧾 Usage: ${parts.join(" ")}`;
}

/** Design Review happens within Spec & Design; the agent does not advance the card. */
export function routeSpecResult(run: SpecDesignResult): SpecRoute {
  if (run.timedOut) {
    return {
      destination: null,
      comment:
        "⏱️ The Spec & Design Agent container exceeded its time budget and was killed. " +
        "The card stays in Spec & Design.\n\n```\n" +
        `${run.rawStderr.slice(-1000)}\n\`\`\``,
    };
  }

  if (!run.result) {
    return {
      destination: null,
      comment:
        `❌ Spec & Design Agent produced no parseable result (exit code ${run.exitCode ?? "none"}). ` +
        `Check that Docker is running and the \`spec-design-agent\` image is built on this host. ` +
        `The card stays in Spec & Design for investigation.\n\n\`\`\`\n${run.rawStderr.slice(-1500) || run.rawStdout.slice(-1500)}\n\`\`\``,
    };
  }

  const result = run.result;
  const status = String(result.status ?? "unknown");
  const summary = String(result.summary ?? "(no summary)");
  const nonBlocking = list(result.nonBlockingConcerns);
  const usage = formatUsage(result.usage);

  if (status === "spec_ready") {
    const parts = [
      `✅ Spec & Design Agent finished: **spec ready for human review**.`,
      "",
      summary,
      "",
      `- Spec: \`${String(result.specPath ?? "(path missing)")}\` (v${String(result.specVersion ?? "?")})`,
      `- Spec commit: \`${String(result.specCommit ?? "(missing)")}\` on \`${String(result.branch ?? "?")}\``,
    ];
    if (nonBlocking) parts.push("", "**For the reviewer's attention**", nonBlocking);
    if (usage) parts.push("", usage);
    parts.push(
      "",
      "A human reviews and accepts the specification and implementation plan. The card remains in Spec & Design.",
    );
    return { destination: null, comment: parts.join("\n") };
  }

  if (status === "needs_decision") {
    const decisions = Array.isArray(result.humanDecisions)
      ? (result.humanDecisions as Array<Record<string, unknown>>)
      : [];
    const rendered = decisions
      .map((decision, index) => {
        const lines = [
          `**Decision ${index + 1}: ${String(decision.question ?? "(question missing)")}**`,
          `- Impact: ${String(decision.impact ?? "not stated")}`,
          `- Minimum authority: ${String(decision.minimumAuthority ?? "not stated")}`,
        ];
        const options = list(decision.options);
        if (options) lines.push(`- Options:\n${options.replace(/^/gm, "  ")}`);
        return lines.join("\n");
      })
      .join("\n\n");
    return {
      destination: null,
      comment: [
        `⏸️ Spec & Design Agent needs a human decision before a specification can be written.`,
        "",
        summary,
        "",
        rendered || "_The agent reported needs_decision without an itemised decision._",
        ...(usage ? ["", usage] : []),
      ].join("\n"),
    };
  }

  if (status === "blocked") {
    return {
      destination: null,
      comment: [
        `⛔ Spec & Design is blocked by a precondition (input, integrity, access, or environment).`,
        "",
        summary,
        list(result.blockingConcerns) ? `\n**Blocking concerns**\n${list(result.blockingConcerns)}` : "",
        usage ? `\n${usage}` : "",
        "\nThe card stays in Spec & Design. Resolve the blocker, then move it out and back in to retry.",
      ].join("\n"),
    };
  }

  if (status === "failed") {
    return {
      destination: null,
      comment: [
        `❌ Spec & Design Agent failed unexpectedly (exit code ${run.exitCode ?? "none"}).`,
        "",
        summary,
        // The agent reports *why* it failed in blockingConcerns. Dropping them
        // leaves a paid run with no diagnostic at all.
        list(result.blockingConcerns) ? `\n**What failed**\n${list(result.blockingConcerns)}` : "",
        usage ? `\n${usage}` : "",
        "\nAutomatic retry is not enabled in v0.1. Move the card out of and back into Spec & Design to retry.",
      ].join("\n"),
    };
  }

  return {
    destination: null,
    comment: `⚠️ Spec & Design Agent returned an unrecognised status \`${status}\`. The card stays in Spec & Design.\n\n${summary}`,
  };
}
