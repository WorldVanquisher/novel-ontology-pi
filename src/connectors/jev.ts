/**
 * Decision model interface — Jev (TypeSafe AI "System One") or compatible.
 *
 * Jev generates no text. Send it a compact state + typed questions; it
 * returns probabilities/distributions in ~70-500 ms. Three primitives:
 *  - noul:   yes/no question       -> probability 0..1
 *  - choice: fixed candidate set   -> distribution + confidence (ONE pick)
 *  - score:  ordered scale (2-10)  -> distribution over levels
 *
 * Context limit is ~32k tokens, so questions always carry a compact state
 * summary, never raw chapter text. Pin the model version (e.g. jev-1.13.0)
 * in the novel manifest — do not float on "latest" when thresholds are tuned.
 */

export type DecisionPrimitive = "noul" | "choice" | "score";

export interface DecisionQuestion {
  /** Stable key the calling patch uses to read its answer back. */
  key: string;
  primitive: DecisionPrimitive;
  /** What is being asked, in plain language. */
  instructions: string;
  /** Decision criteria / rubric, kept short. */
  criteria?: string;
  /** choice only: the fixed candidate set (max 255). */
  options?: string[];
  /** score only: ordered level labels, 2..10 of them. */
  levels?: string[];
}

export interface DecisionAnswer {
  key: string;
  /** noul: the probability. choice: the winning option. score: the level. */
  value: number | string;
  /** Full distribution when the model returns one. */
  distribution?: Record<string, number>;
  /** The model's own confidence, 0..1, when reported. */
  confidence?: number;
}

export interface DecisionModel {
  readonly modelId: string;
  /**
   * Evaluate a BATCH of questions against one shared state snapshot.
   * One API call per window — never one call per question.
   */
  decide(state: string, questions: DecisionQuestion[]): Promise<DecisionAnswer[]>;
}

export interface JevConfig {
  apiKey: string;
  endpoint: string; // default https://api.typesafe.ai/v1/systemone
  model: string; // pinned, e.g. "jev-1.13.0"
}

/** Live Jev client. Thin fetch wrapper; wiring is completed with a user key. */
export class JevClient implements DecisionModel {
  readonly modelId: string;
  constructor(private cfg: JevConfig) {
    this.modelId = cfg.model;
  }

  async decide(state: string, questions: DecisionQuestion[]): Promise<DecisionAnswer[]> {
    if (!this.cfg.apiKey) {
      throw new Error(
        "Jev API key missing. Set TYPESAFE_API_KEY (the user provides the decision-model key; never hard-code it).",
      );
    }
    const res = await fetch(this.cfg.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({ model: this.cfg.model, state, questions }),
    });
    if (!res.ok) {
      throw new Error(`Jev request failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { answers: DecisionAnswer[] };
    return body.answers;
  }
}

/**
 * Deterministic decision model for tests and dry runs.
 * Answers come from a test-supplied table keyed by question key,
 * so miniloop gates, recursion and change-set accumulation can be
 * verified with zero model spend.
 */
export class MockDecisionModel implements DecisionModel {
  readonly modelId = "mock-jev";
  constructor(
    private table: Record<string, DecisionAnswer["value"]> = {},
    private defaultConfidence = 0.99,
  ) {}
  async decide(_state: string, questions: DecisionQuestion[]): Promise<DecisionAnswer[]> {
    return questions.map((q) => ({
      key: q.key,
      value: this.table[q.key] ?? (q.primitive === "noul" ? 0 : (q.options?.[0] ?? "")),
      confidence: this.defaultConfidence,
    }));
  }
}
