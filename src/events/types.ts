import type { ChangeProposal } from "../merge/changeset.js";

/** Transport facts, not the Playground's layout-dependent view model. */
export type ProcessingEvent =
  | { type: "block.started"; blockId: string }
  | { type: "sectioned"; blockId: string; sentences: number }
  | { type: "proposal.added"; changesetId: string; proposal: Pick<ChangeProposal, "id" | "kind" | "confidence" | "provenance"> }
  | { type: "changeset.pending" | "changeset.approved" | "changeset.held" | "changeset.revision_requested" | "changeset.accumulating"; changesetId: string; proposalIds: string[] }
  | { type: "changeset.applied"; changesetId: string; target: "store"; processed: number; unsupportedProposalIds: string[] }
  | { type: "changeset.merged"; changesetId: string; target: "store" }
  | { type: "graph.rebuilt"; counts: { entities: number; events: number; scenes: number; relations: number; branches: number } };

export interface EventRecord {
  version: 1;
  /** Zero-padded decimal byte offset immediately after this record's newline. */
  id: string;
  timestamp: string;
  event: ProcessingEvent;
}

export type EventSink = (event: ProcessingEvent) => Promise<void>;

/** Explicit projection: never serialize model objects, errors, payload properties or review notes. */
export function projectEvent(event: ProcessingEvent): ProcessingEvent {
  switch (event.type) {
    case "block.started": return { type: event.type, blockId: event.blockId };
    case "sectioned": return { type: event.type, blockId: event.blockId, sentences: event.sentences };
    case "proposal.added": {
      const p = event.proposal;
      return { type: event.type, changesetId: event.changesetId, proposal: {
        id: p.id, kind: p.kind, confidence: p.confidence,
        provenance: { blockId: p.provenance.blockId, sentenceIds: [...p.provenance.sentenceIds], patchId: p.provenance.patchId },
      } };
    }
    case "changeset.pending": case "changeset.approved": case "changeset.held":
    case "changeset.revision_requested": case "changeset.accumulating":
      return { type: event.type, changesetId: event.changesetId, proposalIds: [...event.proposalIds] };
    case "changeset.applied": return { type: event.type, changesetId: event.changesetId, target: "store", processed: event.processed, unsupportedProposalIds: [...event.unsupportedProposalIds] };
    case "changeset.merged": return { type: event.type, changesetId: event.changesetId, target: "store" };
    case "graph.rebuilt": {
      const c = event.counts;
      return { type: event.type, counts: { entities: c.entities, events: c.events, scenes: c.scenes, relations: c.relations, branches: c.branches } };
    }
    default: throw new Error("Unsupported processing event");
  }
}
