import type { DecisionModel } from "../connectors/jev.js";
import type { Sentence } from "../text/sectioning.js";
import type { DialogueTurn, Entity } from "../ontology/types.js";
import { newChangeSet, type ChangeSet } from "../merge/changeset.js";
import type { PatchContext } from "./patches/types.js";
import { PATCH_REGISTRY } from "./patches/index.js";
import {
  nominateCandidateSpans,
  scanKnownNames,
  type CandidateNomination,
  type NameScanHit,
} from "./patches/name-detector.js";

/** One window's structured decisions, snapshotted for the extraction step. */
export interface WindowRecord {
  sentenceIds: string[];
  dialogueUnits: string[][];
  turns: DialogueTurn[];
  charactersPresent: string[];
  charactersMentioned: string[];
}

export interface MiniloopResult {
  changeset: ChangeSet;
  escalations: { patchId: string; unitId: string; reason: string }[];
  accepted: Record<string, unknown>;
  windows: WindowRecord[];
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
    private opts: {
      windowSize?: number;
      /**
       * Zero-context candidate refinement (sector 04): given the code's
       * nominated spans, return the candidate name forms for Jev to
       * judge. Backed by the work LLM when configured; when absent, the
       * raw nominated spans are the candidates.
       */
      refineNameCandidates?: (
        nominations: CandidateNomination[],
        sentences: Sentence[],
      ) => Promise<string[]>;
    } = {},
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
    // Presence candidates, per the presence patch's documented design:
    // the characters the name scan found mentioned in this block. (The
    // previous scene's carry-over joins here once scene state threads
    // through the loop.)
    ctx.accepted["presenceCandidates"] = [
      ...new Set(
        (ctx.accepted["nameHits"] as NameScanHit[]).map((h) => h.entityId),
      ),
    ];
    // New-name candidates (sector 04): code nominates spans, the
    // optional zero-context refiner extracts the name forms, and the
    // name patch's Jev questions judge them — once per block, in the
    // first window (the list is cleared after it).
    const nominations = nominateCandidateSpans(input.sentences, input.knownEntities);
    ctx.accepted["nameCandidates"] = this.opts.refineNameCandidates
      ? await this.opts.refineNameCandidates(nominations, input.sentences)
      : nominations.map((n) => n.span);

    const windows: WindowRecord[] = [];
    const seenProposalIds = new Set<string>();
    let firstWindow = true;
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
        for (const p of outcome.proposals) {
          // A patch that re-runs per window must not double-propose:
          // proposal ids are deterministic, so dedupe on them.
          if (seenProposalIds.has(p.id)) continue;
          seenProposalIds.add(p.id);
          changeset.proposals.push(p);
        }
        escalations.push(
          ...outcome.escalations.map((e) => ({ patchId: patch.id, ...e })),
        );
      }

      windows.push({
        sentenceIds: [...ctx.windowSentenceIds],
        dialogueUnits: ((ctx.accepted["dialogueUnits"] as string[][] | undefined) ?? []).map((u) => [...u]),
        turns: ((ctx.accepted["turns"] as DialogueTurn[] | undefined) ?? []).map((t) => ({ ...t, sentenceIds: [...t.sentenceIds] })),
        charactersPresent: [...((ctx.accepted["charactersPresent"] as string[] | undefined) ?? [])],
        charactersMentioned: [...((ctx.accepted["charactersMentioned"] as string[] | undefined) ?? [])],
      });
      if (firstWindow) {
        // Candidates are judged once per block (see above); later
        // windows must not re-ask the same new-vs-nickname questions.
        ctx.accepted["nameCandidates"] = [];
        firstWindow = false;
      }
    }

    changeset.status = "pending_review";
    return { changeset, escalations, accepted: ctx.accepted, windows };
  }
}
