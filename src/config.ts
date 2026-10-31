// ABOUTME: Loads repository configuration and user-level agent credentials for the orchestrator.
import dotenv from "dotenv";
import { resolve } from "node:path";
import { defaultRuntimeSecretsFile } from "./runtimeConfig.js";

dotenv.config({ path: process.env.ORCHESTRATOR_SECRETS_FILE ?? defaultRuntimeSecretsFile() });
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function choice<T extends readonly string[]>(name: string, values: T, fallback: T[number]): T[number] {
  const value = process.env[name] ?? fallback;
  if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  return value as T[number];
}

const targetRepo = required("TARGET_REPO");

export const config = {
  trelloApiKey: required("TRELLO_API_KEY"),
  trelloToken: required("TRELLO_TOKEN"),
  trelloApiSecret: required("TRELLO_API_SECRET"),
  boardId: required("TRELLO_BOARD_ID"),
  boardWorkflowTemplate:
    process.env.TRELLO_WORKFLOW_TEMPLATE ?? resolve(targetRepo, "..", "agentic-sdlc", "templates", "trello-board-workflow.yaml"),
  lifecycleSchemaPath:
    process.env.AGENTIC_SDLC_SCHEMA_PATH ?? resolve(targetRepo, "..", "agentic-sdlc", "schemas", "lifecycle-contracts.schema.json"),
  wipLimit: Number(process.env.WIP_LIMIT ?? "1"),
  // The Coding Agent runs as an authenticated HTTP service on the NAS; the
  // Orchestrator holds only its API token, never the agent's own credentials.
  codingAgentApiUrl: required("CODING_AGENT_API_URL"),
  codingAgentApiToken: required("CODING_AGENT_API_TOKEN"),
  codingAgentPollIntervalMs: Number(process.env.CODING_AGENT_POLL_INTERVAL_MS ?? "15000"),
  codingAgentTimeoutMs: Number(process.env.CODING_AGENT_TIMEOUT_MS ?? "3600000"),
  // The Spec & Design Agent runs as a one-shot Docker container on this host.
  // The image is built and deployed separately (spec-design-agent/compose.yaml);
  // the orchestrator only invokes `docker run` against it.
  specDesignDockerBin: process.env.SPEC_DESIGN_AGENT_DOCKER ?? "docker",
  specDesignImage: process.env.SPEC_DESIGN_AGENT_IMAGE ?? "spec-design-agent:local",
  specDesignProvider: process.env.SPEC_DESIGN_AGENT_PROVIDER ?? "claude",
  specDesignKickoffMode: choice("SPEC_DESIGN_KICKOFF_MODE", ["auto", "manual"] as const, "auto"),
  specDesignRuntime: choice("SPEC_DESIGN_RUNTIME", ["docker", "local"] as const, "docker"),
  specDesignAgentDirectory: process.env.SPEC_DESIGN_AGENT_DIR ?? resolve(targetRepo, "..", "spec-design-agent"),
  specDesignUvBin: process.env.SPEC_DESIGN_UV ?? "uv",
  // Agent-specific env-file passed directly to the Spec & Design runtime.
  specDesignRuntimeEnvFile:
    process.env.SPEC_DESIGN_AGENT_RUNTIME_ENV ?? resolve(targetRepo, "..", ".config", "spec-design-agent", "runtime.env"),
  specDesignTimeoutMs: Number(process.env.SPEC_DESIGN_AGENT_TIMEOUT_MS ?? "900000"),
  // Intent-backlog uses its dedicated access token. Product repositories use
  // short-lived, repository-scoped GitHub App installation tokens.
  intentBacklogReadToken: process.env.INTENT_BACKLOG_READ_TOKEN ?? "",
  orchestratorGithubAppId: process.env.ORCHESTRATOR_GITHUB_APP_ID ?? "",
  orchestratorGithubAppInstallationId: process.env.ORCHESTRATOR_GITHUB_APP_INSTALLATION_ID ?? "",
  orchestratorGithubAppPrivateKeyFile: process.env.ORCHESTRATOR_GITHUB_APP_PRIVATE_KEY_FILE ?? "",
  evaluatorApiUrl: required("EVALUATOR_API_URL"),
  evaluatorApiToken: required("EVALUATOR_API_TOKEN"),
  targetRepo,
  // Where the isolated per-work-item clones are created before being bind-mounted
  // into the container at /work.
  specWorkspaceRoot: process.env.SPEC_WORKSPACE_ROOT ?? resolve(targetRepo, "..", "agentic-sdlc-workspaces"),
  intentBacklogApiBase: process.env.INTENT_BACKLOG_API_BASE ?? "https://api.github.com",
  callbackUrl: required("CALLBACK_URL"),
  port: Number(process.env.PORT ?? "8787"),
};

export const webhookUrl = `${config.callbackUrl.replace(/\/$/, "")}/webhooks/trello`;
