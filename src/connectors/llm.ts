/**
 * Work model interface — the ONE user-provided LLM API.
 *
 * All text generation goes through here: per-scene ontology extraction,
 * English summaries, adjudication of units the miniloop escalates,
 * character simulation, and story continuation on a branch.
 * Implementation target: Pi's unified provider layer (@earendil-works/pi-ai),
 * so any Pi-supported provider (DeepSeek, OpenAI, Anthropic, ...) works.
 */
export interface WorkModel {
  readonly modelId: string;
  generate(request: {
    system: string;
    prompt: string;
    /** Ask for a JSON object conforming to a caller-side schema. */
    jsonSchema?: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<string>;
}

/** Placeholder until the Pi provider layer is wired in. */
export class UnwiredWorkModel implements WorkModel {
  readonly modelId = "unwired";
  async generate(): Promise<string> {
    throw new Error(
      "Work LLM not wired yet. Configure WORK_LLM_* (one user-provided LLM API) — see .env.example.",
    );
  }
}
