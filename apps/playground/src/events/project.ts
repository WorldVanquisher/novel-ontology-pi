import type { PlaygroundEvent } from "../types.js";

/**
 * Projection from the CLI's processing events to PlaygroundEvents.
 *
 * The CLI deliberately emits TRANSPORT FACTS (src/events/types.ts in the
 * CLI package): what happened, with ids and confidences — never layout,
 * labels-as-art, or view state. This module is the one place that turns
 * those facts into the playground's view-level events.
 *
 * What maps 1:1: block progress, sectioning, gate arrivals and verdicts,
 * merges, graph rebuilds — the live theater (feed, pipeline strip, gate
 * queue, activity shine) works fully from the stream.
 *
 * What does NOT map: the CLI sends no node geometry, so a live
 * `proposal.added` becomes a decision-feed verdict line instead of an
 * in-place ghost node. Ghost rendering stays a file-mode capability
 * until the CLI serves a view-model endpoint next to the event stream.
 * Nothing is fabricated here to paper over that gap.
 */

/** Mirror of the CLI's ChangeProposal provenance (transport subset). */
export interface ProposalFact {
  id: string;
  kind: string;
  confidence: number;
  provenance: { blockId: string; sentenceIds: string[]; patchId: string };
}

/** Mirror of the CLI's ProcessingEvent union (src/events/types.ts). */
export type ProcessingEvent =
  | { type: "block.started"; blockId: string }
  | { type: "sectioned"; blockId: string; sentences: number }
  | { type: "proposal.added"; changesetId: string; proposal: ProposalFact }
  | {
      type:
        | "changeset.pending"
        | "changeset.approved"
        | "changeset.held"
        | "changeset.revision_requested"
        | "changeset.accumulating";
      changesetId: string;
      proposalIds: string[];
    }
  | {
      type: "changeset.applied";
      changesetId: string;
      target: "store";
      processed: number;
      unsupportedProposalIds: string[];
    }
  | { type: "changeset.merged"; changesetId: string; target: "store" }
  | {
      type: "graph.rebuilt";
      counts: { entities: number; events: number; scenes: number; relations: number; branches: number };
    };

/** One record of the CLI's events.jsonl / watch stream. */
export interface EventRecord {
  version: 1;
  id: string;
  timestamp: string;
  event: ProcessingEvent;
}

const pct = (confidence: number) => `${Math.round(confidence * 100)}%`;

export function projectProcessingEvent(event: ProcessingEvent): PlaygroundEvent[] {
  switch (event.type) {
    case "block.started":
      return [{ type: "block.started", blockId: event.blockId, label: `Block ${event.blockId}` }];
    case "sectioned":
      return [{ type: "sectioned", blockId: event.blockId, sentences: event.sentences }];
    case "proposal.added": {
      const p = event.proposal;
      const scope =
        p.provenance.sentenceIds.length > 0
          ? ` · ${p.provenance.sentenceIds.length} sentence${p.provenance.sentenceIds.length === 1 ? "" : "s"}`
          : "";
      return [
        {
          type: "verdict",
          patch: p.provenance.patchId,
          text: `◈ ${p.kind} proposed · ${pct(p.confidence)}${scope}`,
        },
      ];
    }
    case "changeset.pending":
      return [
        {
          type: "changeset.pending",
          changesetId: event.changesetId,
          label: `ChangeSet ${event.changesetId}`,
          nodeIds: event.proposalIds,
        },
      ];
    case "changeset.held":
      return [{ type: "changeset.held", changesetId: event.changesetId, nodeIds: event.proposalIds }];
    case "changeset.approved":
      return [
        { type: "verdict", patch: "merge-gate", text: `⚖ ${event.changesetId} approved at the gate` },
      ];
    case "changeset.revision_requested":
      return [
        {
          type: "verdict",
          patch: "merge-gate",
          text: `↩ ${event.changesetId} sent back for revision`,
        },
      ];
    case "changeset.accumulating":
      return [];
    case "changeset.applied": {
      const skipped = event.unsupportedProposalIds.length
        ? ` · ${event.unsupportedProposalIds.length} deferred`
        : "";
      return [
        {
          type: "verdict",
          patch: "merge-gate",
          text: `✓ ${event.changesetId} applied — ${event.processed} proposal${event.processed === 1 ? "" : "s"}${skipped}`,
        },
      ];
    }
    case "changeset.merged":
      return [{ type: "changeset.merged", changesetId: event.changesetId }];
    case "graph.rebuilt":
      return [{ type: "graph.rebuilt" }];
    default:
      return [];
  }
}
