import { sectionBlock } from "../text/sectioning.js";
import { Miniloop } from "../autostep/miniloop.js";
import type { DecisionModel } from "../connectors/jev.js";
import type { OntologyStore } from "../ontology/store.js";
import type { Entity } from "../ontology/types.js";
import type { ChangeSet } from "../merge/changeset.js";
import { applyChangeSet } from "../merge/apply.js";
import { saveChangeSet } from "../merge/changesetStore.js";
import { EventLog } from "../events/log.js";
import type { EventSink } from "../events/types.js";

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
    private observation: {
      novelDir?: string;
      emit?: EventSink;
      /**
       * Loads the entities the miniloop should treat as already known
       * (the cumulative per-novel name registry). Called before EVERY
       * block, so entities merged by earlier blocks — or earlier runs —
       * are visible to the name scan and the presence patch. When not
       * provided, blocks start with an empty registry.
       */
      loadKnownEntities?: () => Promise<Entity[]>;
    } = {},
  ) {}

  async processNovel(blocks: { blockId: string; text: string }[]): Promise<{
    mergedBlocks: string[];
    stoppedAt: string | null;
    stopReason: string | null;
  }> {
    const mergedBlocks: string[] = [];
    const miniloop = new Miniloop(this.decisions);
    const emit = this.observation.emit ?? (this.observation.novelDir ? new EventLog(this.observation.novelDir).emit : undefined);

    for (const block of blocks) {
      await emit?.({ type: "block.started", blockId: block.blockId });
      const { sentences } = sectionBlock(block.text, mergedBlocks.length);
      await emit?.({ type: "sectioned", blockId: block.blockId, sentences: sentences.length });
      let revisionRounds = 0;
      for (;;) {
        const knownEntities = this.observation.loadKnownEntities
          ? await this.observation.loadKnownEntities()
          : [];
        const result = await miniloop.runBlock({
          blockId: block.blockId,
          sentences,
          knownEntities,
          stateSummary: `Processing block ${block.blockId}.`,
        });
        if (this.observation.novelDir) await saveChangeSet(this.observation.novelDir, result.changeset);
        // No event emissions here: saveChangeSet is the emitter of record
        // for proposal.added / changeset.<status> — it fires them only
        // after the persisted state is visible, deduped by status change.
        const decision = await this.review(result.changeset);
        result.changeset.status = decision;
        if (this.observation.novelDir) await saveChangeSet(this.observation.novelDir, result.changeset);
        if (decision === "approved") {
          result.changeset.status = "approved";
          await applyChangeSet(this.store, result.changeset, emit);
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
