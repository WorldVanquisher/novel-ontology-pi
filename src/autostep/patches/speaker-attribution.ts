import type { DecisionQuestion } from "../../connectors/jev.js";
import type { DecisionPatch, PatchContext, PatchOutcome } from "./types.js";
import { EMPTY_OUTCOME } from "./types.js";

/**
 * Speaker Attribution patch.
 * Consumes dialogue units from the dialogue-detector patch.
 *  - dialogue_speaker (choice) which present character speaks this unit —
 *    candidates are characters present + narrator + unknown. choice is a
 *    single pick, which is exactly right for a speaker.
 * Output: turns into ctx.accepted["turns"] for scene assembly.
 */
export const speakerAttribution: DecisionPatch = {
  id: "speaker-attribution",
  description: "Assigns each dialogue unit to a speaker.",
  gates: { accept: 0.8, reask: 0.5 },

  buildQuestions(ctx: PatchContext): DecisionQuestion[] {
    const units = (ctx.accepted["dialogueUnits"] as string[][] | undefined) ?? [];
    const present = (ctx.accepted["charactersPresent"] as string[] | undefined) ?? [];
    return units.map((u, i) => ({
      key: `speaker:${i}`,
      primitive: "choice" as const,
      instructions: `Who speaks the dialogue in sentences ${u.join(", ")}? Candidate identities: ${present.map((id) => `${id} = ${ctx.knownEntities.find((entity) => entity.id === id)?.names.map((form) => form.text).join(" / ")}`).join("; ")}. Select unknown unless supported by the text.`,
      criteria:
        "Use speech style, forms of address, the previous turn's speaker (dialogue usually alternates), and who the surrounding narration focuses on.",
      options: [...present, "narrator", "unknown"],
    }));
  },

  applyAnswers(ctx: PatchContext, answers): PatchOutcome {
    const units = (ctx.accepted["dialogueUnits"] as string[][] | undefined) ?? [];
    const turns = units.map((sentenceIds, i) => {
      const a = answers.find((x) => x.key === `speaker:${i}`);
      const v = typeof a?.value === "string" ? a.value : "unknown";
      return {
        speakerId: v === "narrator" || v === "unknown" ? null : v,
        addresseeId: null,
        sentenceIds,
      };
    });
    ctx.accepted["turns"] = turns;
    const escalations = turns
      .filter((t) => t.speakerId === null)
      .map((t) => ({
        unitId: t.sentenceIds[0] ?? "?",
        reason: "speaker unresolved by decision model",
      }));
    return { ...EMPTY_OUTCOME, escalations };
  },
};
