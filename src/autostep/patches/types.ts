import type { DecisionAnswer, DecisionQuestion } from "../../connectors/jev.js";
import type { Sentence } from "../../text/sectioning.js";
import type { ChangeProposal } from "../../merge/changeset.js";
import type { Entity } from "../../ontology/types.js";

/**
 * A decision patch is ONE functionality of the System 1 miniloop:
 * dialogue detection, name detection, scene boundaries, speaker
 * attribution, presence, ... Each patch is independent:
 *
 *   1. It receives the auto-sectioned sentences (IDs + text) and a compact
 *      state summary (known entities, scene-so-far, last speaker, ...).
 *   2. It builds its OWN batch of Jev questions — different functionalities
 *      need different questions, primitives and thresholds.
 *   3. It interprets the answers into ChangeProposals (never direct writes)
 *      and/or escalations (units the work LLM must adjudicate).
 *
 * Adding a functionality = adding a patch. The patch list itself is an
 * OPEN design topic (see DESIGN.md §Open questions); v1 ships the patches
 * marked there, shaped so the rest slot in without a schema change.
 */
export interface PatchContext {
  blockId: string;
  sentences: Sentence[];
  /** Sliding window the patch is currently deciding over. */
  windowSentenceIds: string[];
  /** Entities already in the main graph (alias scan results included). */
  knownEntities: Entity[];
  /** Compact English state summary handed to the decision model. */
  stateSummary: string;
  /** Decisions accepted so far in this block, for cross-patch context. */
  accepted: Record<string, unknown>;
}

export interface PatchOutcome {
  proposals: ChangeProposal[];
  /** Sentence/unit IDs whose decisions were too uncertain for Jev alone. */
  escalations: { unitId: string; reason: string }[];
  /** Confidence per decided unit, for the merge-gate review summary. */
  unitConfidences: Record<string, number>;
}

export interface DecisionPatch {
  readonly id: string;
  readonly description: string;
  /** Confidence gates for THIS patch (patches tune independently). */
  readonly gates: { accept: number; reask: number };
  buildQuestions(ctx: PatchContext): DecisionQuestion[];
  applyAnswers(
    ctx: PatchContext,
    answers: DecisionAnswer[],
  ): PatchOutcome;
}

export const EMPTY_OUTCOME: PatchOutcome = {
  proposals: [],
  escalations: [],
  unitConfidences: {},
};
