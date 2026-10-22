/**
 * Playground domain types — sector 13.
 *
 * One graph is the source of truth; every view (timeline lanes, a big
 * event's 3D interior, the gate queue) is a camera over it. Live agent
 * activity arrives as PlaygroundEvents and renders IN PLACE — proposed
 * nodes are ghosts wherever they belong, never a separate screen.
 */

export type LaneId = "canon" | "branch";
export type NodeKind =
  | "bigEvent"
  | "character"
  | "location"
  | "scene"
  | "event"
  | "dialogue";

/** canon = merged truth · proposed = ghost awaiting the gate · held = gate held it (visually distinct) */
export type CanonState = "canon" | "proposed" | "held";

export interface WorldNode {
  id: string;
  label: string;
  subLabel?: string;
  kind: NodeKind;
  state: CanonState;
  /** Which big event's interior this node lives in (null = lane-level node). */
  parent: string | null;
  lane: LaneId;
  /** Rough chronological order key inside its view. */
  chrono: number;
  /** Position in the lanes view. */
  lanePos: [number, number, number];
  /** Position inside the parent big event's interior view. */
  interiorPos: [number, number, number];
}

export interface WorldEdge {
  id: string;
  from: string;
  to: string;
  kind: "flow" | "contains" | "speaks" | "cross";
  state: CanonState;
  parent: string | null;
}

export interface ChangeSet {
  id: string;
  label: string;
  status: "pending" | "held" | "merged";
  nodeIds: string[];
}

export type ViewState =
  | { mode: "lanes" }
  | { mode: "interior"; bigEventId: string };

/** The event contract between the CLI and the playground (sector 13). */
export type PlaygroundEvent =
  | { type: "block.started"; blockId: string; label: string }
  | { type: "sectioned"; blockId: string; sentences: number }
  | { type: "verdict"; patch: string; text: string }
  | {
      type: "proposal.added";
      changesetId: string;
      node: WorldNode;
      edges: WorldEdge[];
    }
  | { type: "changeset.pending"; changesetId: string; label: string; nodeIds: string[] }
  | { type: "changeset.held"; changesetId: string; nodeIds: string[] }
  | { type: "changeset.merged"; changesetId: string }
  | { type: "graph.rebuilt" };

export interface EventSource {
  subscribe(handler: (event: PlaygroundEvent) => void): () => void;
  /** File sources load asynchronously; SSE sources connect synchronously. */
  start(): void | Promise<void>;
  stop(): void;
}
