import type {
  Entity,
  OntEvent,
  Relation,
  Scene,
} from "../ontology/types.js";

/**
 * A ChangeSet is the ONLY output the System 1 miniloop is allowed to
 * produce from a block of novel text: a list of PROPOSED changes to the
 * ontology main graph. The miniloop never writes to the main graph.
 *
 * The main agent (Pi agent, System 2 — with the full conversation, the
 * memories, and every capability) reviews the accumulated ChangeSet and:
 *   - approves the merge  -> proposals are applied via OntologyStore
 *   - holds it            -> nothing is applied; processing pauses
 *   - requests a revision -> names specific proposals/parts to re-run;
 *                            the miniloop reprocesses only those parts and
 *                            produces a revised ChangeSet for the block
 * Then the next block rolls. This repeats until the novel is done.
 */
export type ProposalKind =
  | "upsert_entity"
  | "add_alias"
  | "create_event"
  | "create_scene"
  | "add_relation"
  | "set_state_change";

export interface ChangeProposal {
  id: string;
  kind: ProposalKind;
  /** Entity / event / scene / relation payload, by kind. */
  payload: Entity | OntEvent | Scene | Relation | Record<string, unknown>;
  /** Mean confidence of the decisions that produced this proposal. */
  confidence: number;
  provenance: {
    blockId: string;
    sentenceIds: string[];
    /** Which decision patch produced it, e.g. "dialogue-detector". */
    patchId: string;
  };
}

export type ChangeSetStatus =
  | "accumulating"
  | "pending_review"
  | "approved"
  | "held"
  | "revision_requested";

export interface ChangeSet {
  id: string;
  blockId: string;
  proposals: ChangeProposal[];
  status: ChangeSetStatus;
  /** Per-proposal review notes when held / revision is requested. */
  reviewNotes: Record<string, string>;
  createdAt: string;
}

export function newChangeSet(blockId: string): ChangeSet {
  return {
    id: `cs_${blockId}`,
    blockId,
    proposals: [],
    status: "accumulating",
    reviewNotes: {},
    createdAt: new Date().toISOString(),
  };
}
