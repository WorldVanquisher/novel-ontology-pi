import type { DecisionQuestion } from "../../connectors/jev.js";
import type { DecisionPatch, PatchContext, PatchOutcome } from "./types.js";
import { EMPTY_OUTCOME } from "./types.js";

/**
 * Presence Detector patch — "which characters are in a scene".
 *
 * Jev's `choice` returns ONE pick, so presence must be asked as one
 * noul (yes/no) per candidate character. Candidates are pre-filtered by
 * the deterministic name scan (mentioned anywhere near the scene) plus
 * characters carried over from the previous scene.
 *
 * The crucial distinction this patch protects: a character can be
 * MENTIONED in a scene (talked about, remembered) without being PRESENT.
 * Only presence feeds simulation state; mention becomes a MENTIONED_IN
 * edge, not PRESENT_IN.
 */
export const presenceDetector: DecisionPatch = {
  id: "presence-detector",
  description:
    "Per-candidate yes/no: is this character physically present in the scene, or only mentioned?",
  gates: { accept: 0.85, reask: 0.55 },

  buildQuestions(ctx: PatchContext): DecisionQuestion[] {
    const candidates =
      (ctx.accepted["presenceCandidates"] as string[] | undefined) ?? [];
    const qs: DecisionQuestion[] = [];
    for (const id of candidates) {
      qs.push({
        key: `present:${id}`,
        primitive: "noul",
        instructions: `Is character ${id} physically present and able to act/speak in this scene (not merely mentioned, remembered, or spoken about)?`,
      });
    }
    return qs;
  },

  applyAnswers(ctx: PatchContext, answers): PatchOutcome {
    const present: string[] = [];
    const mentioned: string[] = [];
    for (const a of answers) {
      if (!a.key.startsWith("present:")) continue;
      const id = a.key.slice("present:".length);
      const p = typeof a.value === "number" ? a.value : 0;
      if (p >= 0.5) present.push(id);
      else mentioned.push(id);
    }
    ctx.accepted["charactersPresent"] = present;
    ctx.accepted["charactersMentioned"] = mentioned;
    return EMPTY_OUTCOME;
  },
};
