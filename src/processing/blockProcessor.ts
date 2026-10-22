import { sectionBlock } from "../text/sectioning.js";
import { Miniloop } from "../autostep/miniloop.js";
import type { DecisionModel } from "../connectors/jev.js";
import type { WorkModel } from "../connectors/llm.js";
import type {
  ExtractionInput,
  ExtractionOutput,
} from "../extraction/extraction.js";
import { createCandidateRefiner, createExtractor } from "../extraction/extraction.js";
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
 *     3. per-scene extraction with the work LLM     (sector 08;
 *        -> appends event/causality proposals        runs when a work
 *        to the same ChangeSet                       model is wired)
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
      /**
       * The work LLM. When provided, the extraction step (sector 08)
       * runs between the miniloop and the merge gate, and the
       * zero-context candidate refiner is available to the miniloop.
       * When absent, blocks produce miniloop-only ChangeSets.
       */
      workModel?: WorkModel;
      /** Distinct event/scene counts in the bundle, for ID/order sequencing. */
      loadCounts?: () => Promise<{ events: number; scenes: number }>;
    } = {},
  ) {}

  async processNovel(blocks: { blockId: string; text: string; chapterIndex?: number }[]): Promise<{
    mergedBlocks: string[];
    stoppedAt: string | null;
    stopReason: string | null;
  }> {
    const mergedBlocks: string[] = [];
    const miniloop = new Miniloop(this.decisions, {
      refineNameCandidates: this.observation.workModel
        ? createCandidateRefiner(this.observation.workModel)
        : undefined,
    });
    const extract = this.observation.workModel
      ? createExtractor(this.observation.workModel)
      : undefined;
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
        if (extract) {
          // Sector 08: extraction reads the miniloop's structured
          // scenes and returns the block's FINAL proposal list —
          // stubs fleshed or dropped, aliases folded, events,
          // relations and state changes appended — before anything
          // is saved or shown to the gate.
          const counts = this.observation.loadCounts
            ? await this.observation.loadCounts()
            : { events: 0, scenes: 0 };
          const out: ExtractionOutput = await extract({
            blockId: block.blockId,
            chapterIndex: block.chapterIndex ?? 0,
            sentences,
            miniloop: result,
            knownEntities,
            proposals: result.changeset.proposals,
            counts,
          } satisfies ExtractionInput);
          result.changeset.proposals = out.proposals;
          Object.assign(result.changeset.reviewNotes, out.notes);
        }
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
