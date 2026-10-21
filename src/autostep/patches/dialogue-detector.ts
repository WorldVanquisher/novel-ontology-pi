import type { DecisionQuestion } from "../../connectors/jev.js";
import type { DecisionPatch, PatchContext, PatchOutcome } from "./types.js";
import { EMPTY_OUTCOME } from "./types.js";

/**
 * Dialogue Detector patch.
 *
 * Input: sentence IDs from the auto segregation (sectioning).
 * Job: choose WHICH sentences are dialogue, and stitch multi-sentence
 * dialogue turns — "which sentences belong to this dialogue".
 *
 * Per-sentence decisions:
 *  - segment_kind              (choice) dialogue / narration /
 *                              interior_monologue / description
 *  - continues_previous_dialogue (noul) this sentence continues the
 *                              dialogue turn started earlier
 * Output: dialogue units (ordered sentence-ID groups) into ctx.accepted
 * for the speaker-attribution patch; no graph proposals of its own.
 */
export const DIALOGUE_KINDS = [
  "dialogue",
  "narration",
  "interior_monologue",
  "description",
] as const;

export const dialogueDetector: DecisionPatch = {
  id: "dialogue-detector",
  description:
    "Classifies each sentence and groups sentences into dialogue units.",
  gates: { accept: 0.85, reask: 0.55 },

  buildQuestions(ctx: PatchContext): DecisionQuestion[] {
    const qs: DecisionQuestion[] = [];
    for (const id of ctx.windowSentenceIds) {
      qs.push({
        key: `kind:${id}`,
        primitive: "choice",
        instructions: `Classify sentence ${id} by its narrative function.`,
        criteria:
          "dialogue = spoken aloud by a character; interior_monologue = a character's unspoken thought; description = setting/sensory detail; narration = everything else.",
        options: [...DIALOGUE_KINDS],
      });
      qs.push({
        key: `cont:${id}`,
        primitive: "noul",
        instructions: `Does sentence ${id} continue the same spoken dialogue turn as the immediately preceding dialogue sentence (same speaker, no narration break)?`,
      });
    }
    return qs;
  },

  applyAnswers(ctx: PatchContext, answers): PatchOutcome {
    const byKey = new Map(answers.map((a) => [a.key, a]));
    const units: string[][] = [];
    const confidences: Record<string, number> = {};
    const escalations: PatchOutcome["escalations"] = [];
    let current: string[] | null = null;

    for (const id of ctx.windowSentenceIds) {
      const kind = byKey.get(`kind:${id}`);
      const conf = kind?.confidence ?? 0;
      confidences[id] = conf;
      if (conf < this.gates.reask) {
        escalations.push({ unitId: id, reason: "segment_kind too uncertain" });
      }
      const isDialogue = kind?.value === "dialogue";
      const cont = byKey.get(`cont:${id}`);
      const continues = typeof cont?.value === "number" && cont.value >= 0.5;
      if (isDialogue) {
        if (current && continues) current.push(id);
        else {
          current = [id];
          units.push(current);
        }
      } else {
        current = null;
      }
    }
    ctx.accepted["dialogueUnits"] = units;
    return { ...EMPTY_OUTCOME, escalations, unitConfidences: confidences };
  },
};
