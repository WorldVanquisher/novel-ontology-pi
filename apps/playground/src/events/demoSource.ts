import type {
  EventSource,
  PlaygroundEvent,
  WorldEdge,
  WorldNode,
} from "../types";

/**
 * DemoEventSource — replays a scripted ingestion session behind the real
 * EventSource interface. When the CLI's `novel watch` (events.jsonl +
 * SSE) lands, an SseEventSource implements the same interface and this
 * file becomes a test fixture.
 *
 * The script mirrors the sector 13 unified demo: while the user browses
 * canon, System 1 knits a block into the BRANCH big event 寻回 (be_found):
 * ghost proposals accumulate, a ChangeSet reaches the gate, part of it
 * is held (distinct ghost state), the rest awaits the user's decision.
 */

const ghost = (n: Partial<WorldNode> & Pick<WorldNode, "id" | "label" | "kind">): WorldNode => ({
  state: "proposed",
  parent: "be_found",
  lane: "branch",
  chrono: 3,
  lanePos: [30, -80, 0],
  interiorPos: [0, 0, 0],
  ...n,
});

const ghostEdge = (e: Partial<WorldEdge> & Pick<WorldEdge, "id" | "from" | "to" | "kind">): WorldEdge => ({
  state: "proposed",
  parent: "be_found",
  ...e,
});

export const DEMO_PROPOSALS: { node: WorldNode; edges: WorldEdge[] }[] = [
  {
    node: ghost({ id: "p_clerk", label: "店员", subLabel: "new character?", kind: "character", chrono: 3, lanePos: [95, -35, 20], interiorPos: [60, 90, 0] }),
    edges: [ghostEdge({ id: "pe1", from: "p_clerk", to: "p_dlg_ask", kind: "speaks" })],
  },
  {
    node: ghost({ id: "p_dlg_ask", label: "对话·询问", subLabel: "黒子 → 店员", kind: "dialogue", chrono: 3.5, lanePos: [105, -105, -15], interiorPos: [80, -30, 10] }),
    edges: [
      ghostEdge({ id: "pe2", from: "b_ev_ask", to: "p_dlg_ask", kind: "flow" }),
      ghostEdge({ id: "pe3", from: "p_dlg_ask", to: "p_ev_early", kind: "flow" }),
    ],
  },
  {
    node: ghost({ id: "p_ev_early", label: "事件·提前归还", subLabel: "uncertain — check me", kind: "event", chrono: 4, lanePos: [45, -140, 10], interiorPos: [190, -30, 0] }),
    edges: [],
  },
];

export const SCRIPT: { at: number; event: PlaygroundEvent }[] = [
  { at: 600, event: { type: "block.started", blockId: "b0011", label: "block b0011 · branch ch.2" } },
  { at: 1500, event: { type: "sectioned", blockId: "b0011", sentences: 38 } },
  { at: 2400, event: { type: "verdict", patch: "presence", text: "jev · present — 黒子 p .96" } },
  { at: 3300, event: { type: "verdict", patch: "dialogue", text: "jev · dialogue — 1 new turn attributed" } },
  { at: 4000, event: { type: "proposal.added", changesetId: "cs_b0011", ...DEMO_PROPOSALS[0] } },
  { at: 4900, event: { type: "proposal.added", changesetId: "cs_b0011", ...DEMO_PROPOSALS[1] } },
  { at: 5800, event: { type: "proposal.added", changesetId: "cs_b0011", ...DEMO_PROPOSALS[2] } },
  { at: 6400, event: { type: "changeset.pending", changesetId: "cs_b0011", label: "cs_b0011 — 6 proposals (branch 寻回)", nodeIds: ["p_clerk", "p_dlg_ask", "p_ev_early"] } },
  { at: 8200, event: { type: "changeset.held", changesetId: "cs_b0011", nodeIds: ["p_ev_early"] } },
];

export class DemoEventSource implements EventSource {
  private handlers = new Set<(event: PlaygroundEvent) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  subscribe(handler: (event: PlaygroundEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  start(): void {
    this.stop();
    for (const step of SCRIPT) {
      this.timers.push(
        setTimeout(() => {
          for (const h of this.handlers) h(step.event);
        }, step.at),
      );
    }
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
