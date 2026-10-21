/**
 * Model-routing configuration — read from the environment only.
 *
 * The user provides TWO APIs (see .env.example and DESIGN.md §1):
 * one work LLM (generation/extraction) and one decision model (Jev).
 * Keys are secrets: this module reports only whether a key is
 * configured, never its value, so `novel config` output is always
 * safe to print, paste, or attach to a bug report.
 */

export type KeyStatus = "configured" | "missing";

export interface ConfigReport {
  workLlm: {
    provider: string;
    model: string | null;
    apiKey: KeyStatus;
    apiKeyEnv: "WORK_LLM_API_KEY";
  };
  decisionModel: {
    provider: "jev";
    endpoint: string;
    /** Pinned model version — never floats on "latest". */
    model: string;
    apiKey: KeyStatus;
    apiKeyEnv: "TYPESAFE_API_KEY";
  };
  embeddings: {
    /** Deferred by decision (DESIGN.md §9): graph-first retrieval. */
    status: "deferred";
    provider: string | null;
    model: string | null;
    dimension: number | null;
  };
  /** Env var NAMES (never values) still needed for a live ingest. */
  missingForLiveIngest: string[];
  readyForLiveIngest: boolean;
}

const nonEmpty = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigReport {
  const workKey = nonEmpty(env.WORK_LLM_API_KEY);
  const jevKey = nonEmpty(env.TYPESAFE_API_KEY);

  const missingForLiveIngest: string[] = [];
  if (!workKey) missingForLiveIngest.push("WORK_LLM_API_KEY");
  if (!jevKey) missingForLiveIngest.push("TYPESAFE_API_KEY");

  const dimensionRaw = nonEmpty(env.EMBEDDING_DIMENSION);
  const dimension = dimensionRaw ? Number(dimensionRaw) : null;

  return {
    workLlm: {
      provider: nonEmpty(env.WORK_LLM_PROVIDER) ?? "deepseek",
      model: nonEmpty(env.WORK_LLM_MODEL),
      apiKey: workKey ? "configured" : "missing",
      apiKeyEnv: "WORK_LLM_API_KEY",
    },
    decisionModel: {
      provider: "jev",
      endpoint: nonEmpty(env.JEV_ENDPOINT) ?? "https://api.typesafe.ai/v1/systemone",
      model: nonEmpty(env.JEV_MODEL) ?? "jev-1.13.0",
      apiKey: jevKey ? "configured" : "missing",
      apiKeyEnv: "TYPESAFE_API_KEY",
    },
    embeddings: {
      status: "deferred",
      provider: nonEmpty(env.EMBEDDING_PROVIDER),
      model: nonEmpty(env.EMBEDDING_MODEL),
      dimension: dimension !== null && Number.isFinite(dimension) ? dimension : null,
    },
    missingForLiveIngest,
    readyForLiveIngest: missingForLiveIngest.length === 0,
  };
}
