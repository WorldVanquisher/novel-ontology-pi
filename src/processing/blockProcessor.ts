import { sectionBlock } from "../text/sectioning.js";
import { Miniloop } from "../autostep/miniloop.js";
import type { DecisionModel } from "../connectors/jev.js";
import type { OntologyStore } from "../ontology/store.js";
import type { ChangeSet } from "../merge/changeset.js";
import { applyChangeSet } from "../merge/apply.js";

export type ReviewDecision = "approved" | "held" | "revision_requested";

/**
 * The outer processing loop — how a whole novel gets ingested.
 *
 *   for each block (chapter, or a long block of text):
 *     1. section the block into sentences          (code)
 *     2. run the System 1 miniloop                 (Jev patches)
 *        -> accumulates a ChangeSet of proposals
 *     3. per-scene extraction with the work LLM    (TODO: extraction step)
 *        -> appends event/causality proposals to the same ChangeSet
 *     4. MERGE GATE: hand the ChangeSet to the main agent.
 *        - approved            -> apply to the main graph, next block
 *        - held                -> stop; nothing applied; awaiting the user
 *        - revision_requested  -> re-run the miniloop for the noted parts
 *                                 only, present a revised ChangeSet
 *   ... until the novel is done.
 *
 * The main agent is the reviewer because it holds what the miniloop
 * cannot: the whole conversation, the user's intent, long-range memory
 * of earlier chapters, and every other capability.
 */
export class BlockProcessor {
  constructor(
    private store: OntologyStore,
    private decisions: DecisionModel,
    private review: (cs: ChangeSet) => Promise<ReviewDecision>,
  ) {}

  async processNovel(blocks: { blockId: string; text: string }[]): Promise<{
    mergedBlocks: string[];
    stoppedAt: string | null;
    stopReason: string | null;
  }> {
    const mergedBlocks: string[] = [];
    const miniloop = new Miniloop(this.decisions);

    for (const block of blocks) {
      const { sentences } = sectionBlock(block.text, mergedBlocks.length);
      let revisionRounds = 0;
      for (;;) {
        const result = await miniloop.runBlock({
          blockId: block.blockId,
          sentences,
          knownEntities: [], // TODO: load from store before each block
          stateSummary: `Processing block ${block.blockId}.`,
        });
        const decision = await this.review(result.changeset);
        if (decision === "approved") {
          result.changeset.status = "approved";
          await applyChangeSet(this.store, result.changeset);
          mergedBlocks.push(block.blockId);
          break;
        }
        if (decision === "held") {
          return {
            mergedBlocks,
            stoppedAt: block.blockId,
            stopReason: "Change set held by the main agent at the merge gate.",
          };
        }
        // revision_requested
        revisionRounds++;
        if (revisionRounds > 2) {
          return {
            mergedBlocks,
            stoppedAt: block.blockId,
            stopReason: "Revision rounds exhausted; needs the user's call.",
          };
        }
        // TODO: re-run only the noted proposals' patches (reviewNotes),
        // not the whole block — granularity is an open design question.
      }
    }
    return { mergedBlocks, stoppedAt: null, stopReason: null };
  }
}
