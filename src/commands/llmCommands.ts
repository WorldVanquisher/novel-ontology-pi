/**
 * `novel llm ping|probe` — smoke commands for the work-LLM plumbing
 * (src/connectors/workModel.ts).
 *
 * These are the ONLY callers of the HTTP work-model client for now:
 * wiring it into ingest/extraction is a separate, later step that
 * happens with live keys. Both commands read WORK_LLM_* from the
 * environment (see src/config.ts) and can be exercised for free by
 * pointing WORK_LLM_BASE_URL at a local mock server.
 *
 * Output reports the key as status only ("configured"); the value is
 * never printed. Missing configuration is a loud, specific error —
 * for a smoke command, silently succeeding would be the bug.
 */
import { loadConfig, type KeyStatus } from "../config.js";
import {
  workModelFromEnv,
  type WorkModelUsage,
} from "../connectors/workModel.js";

export interface LlmPingResult {
  status: "ok";
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: KeyStatus;
  latencyMs: number;
  attempts: number;
  usage: WorkModelUsage;
  reply: string;
}

export interface LlmProbeResult {
  status: "ok";
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: KeyStatus;
  /** The model returned a parseable JSON object matching the probe shape. */
  jsonValid: true;
  latencyMs: number;
  attempts: number;
  usage: WorkModelUsage;
}

/** Smallest possible completion: proves reachability, auth, and model. */
export async function llmPing(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LlmPingResult> {
  const cfg = loadConfig(env);
  const model = workModelFromEnv(env);
  const r = await model.generateWithInfo({
    system: "You are a connectivity smoke test. Reply with exactly: pong",
    prompt: "ping",
    maxTokens: 16,
  });
  return {
    status: "ok",
    provider: cfg.workLlm.provider,
    model: r.model,
    baseUrl: cfg.workLlm.baseUrl ?? "",
    apiKey: "configured",
    latencyMs: r.latencyMs,
    attempts: r.attempts,
    usage: r.usage,
    reply: r.text.trim(),
  };
}

/**
 * Deeper smoke: exercises JSON mode and validates that the reply is a
 * parseable JSON object with the expected shape. The probe payload is
 * deliberately content-free — this tests plumbing, not prompts.
 */
export async function llmProbe(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LlmProbeResult> {
  const cfg = loadConfig(env);
  const model = workModelFromEnv(env);
  const r = await model.generateWithInfo({
    system: "You are a structured-output smoke test. Reply with a JSON object only, no other text.",
    prompt: 'Return exactly this JSON object: {"status":"ok"}',
    jsonSchema: {
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
    },
    maxTokens: 64,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.text);
  } catch {
    throw new Error(
      `llm probe failed: model reply was not valid JSON: ${r.text.slice(0, 200)}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { status?: unknown }).status !== "ok"
  ) {
    throw new Error(
      `llm probe failed: expected a JSON object with status "ok", got: ${r.text.slice(0, 200)}`,
    );
  }
  return {
    status: "ok",
    provider: cfg.workLlm.provider,
    model: r.model,
    baseUrl: cfg.workLlm.baseUrl ?? "",
    apiKey: "configured",
    jsonValid: true,
    latencyMs: r.latencyMs,
    attempts: r.attempts,
    usage: r.usage,
  };
}
