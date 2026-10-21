import type { DecisionQuestion } from "../../connectors/jev.js";
import type { DecisionPatch, PatchContext, PatchOutcome } from "./types.js";
import { EMPTY_OUTCOME } from "./types.js";

/**
 * Scene Boundary patch.
 *  - is_scene_boundary (noul) a new scene starts at this sentence
 *  - boundary_reason   (choice, multi via separate nouls in later versions):
 *    location_changed / time_skipped / pov_changed
 * Output: scene segmentation into ctx.accepted["sceneSpans"] —
 * ordered sentence-ID ranges the other patches and the per-scene
 * extraction step consume.
 */
export const sceneBoundary: DecisionPatch = {
  id: "scene-boundary",
  description: "Decides where scenes start and end within a block.",
  gates: { accept: 0.85, reask: 0.55 },

  buildQuestions(ctx: PatchContext): DecisionQuestion[] {
    return ctx.windowSentenceIds.map((id) => ({
      key: `boundary:${id}`,
      primitive: "noul" as const,
      instructions: `Does a new scene begin at sentence ${id} (change of place, a time skip, or a viewpoint shift from what came immediately before)?`,
    }));
  },

  applyAnswers(ctx: PatchContext, answers): PatchOutcome {
    const byKey = new Map(answers.map((a) => [a.key, a]));
    const spans: string[][] = [];
    let current: string[] = [];
    for (const id of ctx.windowSentenceIds) {
      const a = byKey.get(`boundary:${id}`);
      const p = typeof a?.value === "number" ? a.value : 0;
      if (p >= 0.5 && current.length > 0) {
        spans.push(current);
        current = [];
      }
      current.push(id);
    }
    if (current.length > 0) spans.push(current);
    const prior = (ctx.accepted["sceneSpans"] as string[][] | undefined) ?? [];
    ctx.accepted["sceneSpans"] = [...prior, ...spans];
    return EMPTY_OUTCOME;
  },
};
