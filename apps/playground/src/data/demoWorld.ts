import type { WorldEdge, WorldNode } from "../types";

/**
 * The demo world: a slice of the sample Index corpus used across the
 * design dashboard. Canon lane + one branch lane at chapter range; the
 * big event 归还终端 has a full 3D interior with two parallel chains
 * (café / street) — the same scenario as the sector 13 unified demo.
 */

const N = (
  partial: Partial<WorldNode> & Pick<WorldNode, "id" | "label" | "kind">,
): WorldNode => ({
  state: "canon",
  parent: null,
  lane: "canon",
  chrono: 0,
  lanePos: [0, 0, 0],
  interiorPos: [0, 0, 0],
  ...partial,
});

const E = (
  partial: Partial<WorldEdge> & Pick<WorldEdge, "id" | "from" | "to" | "kind">,
): WorldEdge => ({ state: "canon", parent: null, ...partial });

export const LANE_NODES: WorldNode[] = [
  N({ id: "be_meet", label: "相遇", subLabel: "第一章 · big event", kind: "bigEvent", chrono: 1, lanePos: [-260, 60, 0] }),
  N({ id: "be_promise", label: "约定", subLabel: "第一章 · big event", kind: "bigEvent", chrono: 2, lanePos: [-90, 60, 0] }),
  N({ id: "be_return", label: "归还终端", subLabel: "第二章 · big event — click to enter", kind: "bigEvent", chrono: 3, lanePos: [90, 60, 0] }),
  N({ id: "be_evening", label: "傍晚", subLabel: "第三章 · big event", kind: "bigEvent", chrono: 4, lanePos: [260, 60, 0] }),
  N({ id: "be_kept", label: "终端未丢", subLabel: "branch · big event", kind: "bigEvent", lane: "branch", chrono: 1, lanePos: [-200, -80, 0] }),
  N({ id: "be_found", label: "寻回", subLabel: "branch · big event — agent is knitting here", kind: "bigEvent", lane: "branch", chrono: 2, lanePos: [30, -80, 0] }),
  N({ id: "be_parfait", label: "芭菲", subLabel: "branch · big event", kind: "bigEvent", lane: "branch", chrono: 3, lanePos: [230, -80, 0] }),
];

export const LANE_EDGES: WorldEdge[] = [
  E({ id: "le1", from: "be_meet", to: "be_promise", kind: "flow" }),
  E({ id: "le2", from: "be_promise", to: "be_return", kind: "flow" }),
  E({ id: "le3", from: "be_return", to: "be_evening", kind: "flow" }),
  E({ id: "le4", from: "be_kept", to: "be_found", kind: "flow" }),
  E({ id: "le5", from: "be_found", to: "be_parfait", kind: "flow" }),
  E({ id: "le_fork", from: "be_return", to: "be_kept", kind: "cross" }),
];

/** Interior of be_return: two locations narrated in parallel → two chains. */
export const INTERIORS: Record<string, { nodes: WorldNode[]; edges: WorldEdge[] }> = {
  be_return: {
    nodes: [
      // chain A — café
      N({ id: "cafe", label: "咖啡店", kind: "location", parent: "be_return", chrono: 0, interiorPos: [-250, -10, -30] }),
      N({ id: "scene_counter", label: "场景·柜台", kind: "scene", parent: "be_return", chrono: 1, interiorPos: [-200, 55, -10] }),
      N({ id: "uiharu", label: "初春饰利", kind: "character", parent: "be_return", chrono: 1, interiorPos: [-160, 130, 0] }),
      N({ id: "dlg_a1", label: "对话①", subLabel: "初春 → 美琴", kind: "dialogue", parent: "be_return", chrono: 2, interiorPos: [-110, 55, 10] }),
      N({ id: "ev_found", label: "发现终端", kind: "event", parent: "be_return", chrono: 3, interiorPos: [-20, 55, -15] }),
      N({ id: "mikoto", label: "御坂美琴", kind: "character", parent: "be_return", chrono: 3, interiorPos: [30, 135, 5] }),
      N({ id: "dlg_a2", label: "对话②", subLabel: "美琴 → 初春", kind: "dialogue", parent: "be_return", chrono: 4, interiorPos: [80, 55, 10] }),
      N({ id: "ev_confirm", label: "确认归属", kind: "event", parent: "be_return", chrono: 5, interiorPos: [200, 55, -10] }),
      // chain B — street
      N({ id: "street", label: "街道", kind: "location", parent: "be_return", chrono: 0, interiorPos: [-240, -120, 15] }),
      N({ id: "scene_patrol", label: "场景·巡逻", kind: "scene", parent: "be_return", chrono: 1, interiorPos: [-180, -60, 25] }),
      N({ id: "kuroko", label: "白井黒子", kind: "character", parent: "be_return", chrono: 2, interiorPos: [-120, 10, 30] }),
      N({ id: "dlg_b1", label: "对话③", subLabel: "黒子 → 美琴 · 电话", kind: "dialogue", parent: "be_return", chrono: 2.5, interiorPos: [-60, -60, 40] }),
      N({ id: "ev_patrol", label: "街道巡查", kind: "event", parent: "be_return", chrono: 4, interiorPos: [120, -60, 20] }),
    ],
    edges: [
      E({ id: "ie1", from: "cafe", to: "scene_counter", kind: "contains", parent: "be_return" }),
      E({ id: "ie2", from: "scene_counter", to: "dlg_a1", kind: "flow", parent: "be_return" }),
      E({ id: "ie3", from: "dlg_a1", to: "ev_found", kind: "flow", parent: "be_return" }),
      E({ id: "ie4", from: "ev_found", to: "dlg_a2", kind: "flow", parent: "be_return" }),
      E({ id: "ie5", from: "dlg_a2", to: "ev_confirm", kind: "flow", parent: "be_return" }),
      E({ id: "ie6", from: "street", to: "scene_patrol", kind: "contains", parent: "be_return" }),
      E({ id: "ie7", from: "scene_patrol", to: "dlg_b1", kind: "flow", parent: "be_return" }),
      E({ id: "ie8", from: "dlg_b1", to: "ev_patrol", kind: "flow", parent: "be_return" }),
      E({ id: "ie9", from: "uiharu", to: "dlg_a1", kind: "speaks", parent: "be_return" }),
      E({ id: "ie10", from: "dlg_a1", to: "mikoto", kind: "speaks", parent: "be_return" }),
      E({ id: "ie11", from: "mikoto", to: "dlg_a2", kind: "speaks", parent: "be_return" }),
      E({ id: "ie12", from: "kuroko", to: "dlg_b1", kind: "speaks", parent: "be_return" }),
      E({ id: "ie13", from: "dlg_b1", to: "mikoto", kind: "cross", parent: "be_return" }),
    ],
  },
};

export const BIG_EVENT_LABELS: Record<string, string> = Object.fromEntries(
  LANE_NODES.map((n) => [n.id, n.label]),
);

/** Interior of be_found (branch): the agent knits the proposals into here. */
INTERIORS["be_found"] = {
  nodes: [
    N({ id: "b_street", label: "街道", kind: "location", parent: "be_found", lane: "branch", chrono: 0, interiorPos: [-230, -40, 10] }),
    N({ id: "b_kuroko", label: "白井黒子", kind: "character", parent: "be_found", lane: "branch", chrono: 1, interiorPos: [-140, 90, 20] }),
    N({ id: "b_scene_search", label: "场景·搜寻", kind: "scene", parent: "be_found", lane: "branch", chrono: 1, interiorPos: [-170, -30, 25] }),
    N({ id: "b_ev_ask", label: "沿街询问", kind: "event", parent: "be_found", lane: "branch", chrono: 2, interiorPos: [-40, -30, 15] }),
  ],
  edges: [
    E({ id: "be1", from: "b_street", to: "b_scene_search", kind: "contains", parent: "be_found" }),
    E({ id: "be2", from: "b_scene_search", to: "b_ev_ask", kind: "flow", parent: "be_found" }),
    E({ id: "be3", from: "b_kuroko", to: "b_ev_ask", kind: "speaks", parent: "be_found" }),
  ],
};
