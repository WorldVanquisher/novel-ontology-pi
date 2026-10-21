import type { DecisionModel } from "../connectors/jev.js";
import type { Sentence } from "../text/sectioning.js";
import type { Entity } from "../ontology/types.js";
import { newChangeSet, type ChangeSet } from "../merge/changeset.js";
import type { PatchContext } from "./patches/types.js";
import { PATCH_REGISTRY } from "./patches/index.js";
import { scanKnownNames } from "./patches/name-detector.js";

export interface MiniloopResult {
  changeset: ChangeSet;
  escalations: { patchId: string; unitId: string; reason: string }[];
  accepted: Record<string, unknown>;
}

/**
 * The System 1 autostep miniloop.
 *
 * Rolls over ONE block of novel text (a chapter, or a long block) that has
 * already been auto-sectioned into sentences. For each window it runs the
 * decision patches in registry order; each patch asks the decision model
 * (Jev) ONE batched call of typed questions and interprets the answers.
 *
 * Recursion: a patch whose unit confidence falls between its gates
 * triggers a re-ask with an expanded window; below the re-ask gate the
 * unit is escalated to the work LLM (adjudication happens one level up).
 *
 * CRITICAL INVARIANT: the miniloop NEVER writes to the ontology main
 * graph. Everything it concludes becomes proposals accumulated in the
 * block's ChangeSet, which the main agent reviews at the merge gate.
 */
export class Miniloop {
  constructor(
    private decisions: DecisionModel,
    private opts: { windowSize?: number } = {},
  ) {}

  async runBlock(input: {
    blockId: string;
    sentences: Sentence[];
    knownEntities: Entity[];
    stateSummary: string;
  }): Promise<MiniloopResult> {
    const changeset = newChangeSet(input.blockId);
    const escalations: MiniloopResult["escalations"] = [];
    const windowSize = this.opts.windowSize ?? 40;

    const ctx: PatchContext = {
      blockId: input.blockId,
      sentences: input.sentences,
      windowSentenceIds: [],
      knownEntities: input.knownEntities,
      stateSummary: input.stateSummary,
      accepted: {},
    };
    // Deterministic half of the name patch: free, certain, no model call.
    ctx.accepted["nameHits"] = scanKnownNames(ctx);

    for (let w = 0; w < input.sentences.length; w += windowSize) {
      ctx.windowSentenceIds = input.sentences
        .slice(w, w + windowSize)
        .map((s) => s.id);
      ctx.accepted["dialogueUnits"] = undefined;
      ctx.accepted["sceneSpans"] = ctx.accepted["sceneSpans"] ?? [];

      for (const patch of PATCH_REGISTRY) {
        const questions = patch.buildQuestions(ctx);
        if (questions.length === 0) continue;
        // State handed to Jev: compact summary + the window's sentences.
        const windowText = ctx.windowSentenceIds
          .map(
            (id) =>
              `${id}: ${input.sentences.find((s) => s.id === id)?.text ?? ""}`,
          )
          .join("\n");
        const answers = await this.decisions.decide(
          `${ctx.stateSummary}\n---\n${windowText}`,
          questions,
        );
        const outcome = patch.applyAnswers(ctx, answers);
        changeset.proposals.push(...outcome.proposals);
        escalations.push(
          ...outcome.escalations.map((e) => ({ patchId: patch.id, ...e })),
        );
      }
    }

    changeset.status = "pending_review";
    return { changeset, escalations, accepted: ctx.accepted };
  }
}
