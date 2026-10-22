import { test } from "node:test";
import assert from "node:assert/strict";
import { arrangeTimeline, withOverviewActivity } from "../apps/playground/src/data/timelineLayout.js";
import type { WorldEdge, WorldNode } from "../apps/playground/src/types.js";

function record(id: string, chrono: number, kind: WorldNode["kind"] = "event", lane: WorldNode["lane"] = "canon"): WorldNode {
  return { id, label: id, chrono, kind, lane, state: "canon", parent: null, lanePos: [9, 8, 7], interiorPos: [6, 5, 4] };
}

function relation(from: string, to: string, kind: WorldEdge["kind"] = "flow"): WorldEdge {
  return { id: `${from}-${to}`, from, to, kind, state: "canon", parent: null };
}

test("chapter files form straight ordered tracks and the branch starts at its fork", () => {
  const nodes = [record("canon-3", 3, "bigEvent"), record("branch-2", 2, "bigEvent", "branch"), record("canon-1", 1, "bigEvent"), record("branch-1", 1, "bigEvent", "branch"), record("canon-2", 2, "bigEvent")];
  const original = structuredClone(nodes);
  const result = arrangeTimeline(nodes, [relation("canon-3", "branch-1", "cross")], false);
  const positions = new Map(result.nodes.map((node) => [node.id, node.lanePos]));
  assert.equal(result.tracks.length, 2);
  assert.equal(positions.get("canon-3")![0], positions.get("branch-1")![0]);
  assert.ok(positions.get("canon-1")![0] < positions.get("canon-2")![0]);
  assert.ok(positions.get("canon-2")![0] < positions.get("canon-3")![0]);
  assert.ok(positions.get("branch-1")![0] < positions.get("branch-2")![0]);
  assert.equal(positions.get("canon-1")![1], positions.get("canon-3")![1]);
  assert.notEqual(positions.get("canon-1")![1], positions.get("branch-1")![1]);
  assert.deepEqual(nodes, original);
});

test("parallel story chains share sequence columns without bending or merging through cross-links", () => {
  const nodes = [record("battle-a", 0, "location"), record("a-1", 1), record("a-2", 2), record("battle-b", 0, "location"), record("b-1", 1), record("b-2", 2), record("person-a", 1, "character"), record("person-b", 1, "character")];
  const edges = [relation("battle-a", "a-1", "contains"), relation("a-1", "a-2"), relation("battle-b", "b-1", "contains"), relation("b-1", "b-2"), relation("a-1", "b-2", "cross"), relation("person-a", "a-1", "speaks"), relation("person-b", "b-1", "speaks")];
  const result = arrangeTimeline(nodes, edges, true);
  const positions = new Map(result.nodes.map((node) => [node.id, node.interiorPos]));
  assert.equal(result.tracks.length, 2);
  for (const suffix of ["1", "2"]) assert.equal(positions.get(`a-${suffix}`)![0], positions.get(`b-${suffix}`)![0]);
  assert.equal(positions.get("battle-a")![1], positions.get("a-2")![1]);
  assert.equal(positions.get("battle-b")![1], positions.get("b-2")![1]);
  assert.notEqual(positions.get("a-1")![1], positions.get("b-1")![1]);
  assert.equal(positions.get("person-a")![0], positions.get("a-1")![0]);
  assert.ok(positions.get("person-a")![1] > positions.get("a-1")![1]);
  assert.ok(positions.get("person-b")![1] > positions.get("b-1")![1]);
  for (const track of result.tracks) { assert.equal(track.start[1], track.end[1]); assert.ok(track.end[0] > track.start[0]); }
});

test("cycles and shared character references do not recursively duplicate timeline records", () => {
  const nodes = [record("first", 0), record("second", 1), record("character-1", 0, "character"), record("character-2", 0, "character")];
  const edges = [relation("first", "second"), relation("second", "first"), relation("character-1", "first", "speaks"), relation("character-2", "first", "speaks")];
  const result = arrangeTimeline(nodes, edges, true);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.nodes.length, nodes.length);
  assert.equal(new Set(result.nodes.map((node) => node.id)).size, nodes.length);
  assert.notDeepEqual(result.nodes[2].interiorPos, result.nodes[3].interiorPos);
  assert.deepEqual(arrangeTimeline([], [], true), { nodes: [], tracks: [] });
});

test("overview ghosts and their parent tethers stay visible without moving chapter tracks", () => {
  const chapters = [record("canon", 1, "bigEvent"), record("branch", 1, "bigEvent", "branch"), record("later", 2, "bigEvent", "branch")];
  const chapterEdges = [relation("canon", "branch", "cross"), relation("branch", "later")];
  const ghosts: WorldNode[] = [record("person", 3, "character", "branch"), record("dialogue", 3.5, "dialogue", "branch"), record("event", 4, "event", "branch")]
    .map((node) => ({ ...node, parent: "branch", state: "proposed" }));
  ghosts[2] = { ...ghosts[2], state: "held" };
  const activityEdges = [relation("person", "dialogue", "speaks"), relation("dialogue", "event"), relation("hidden-interior", "dialogue")];
  const original = structuredClone({ chapters, chapterEdges, ghosts, activityEdges });
  const combined = withOverviewActivity(chapters, chapterEdges, ghosts, activityEdges);
  const result = arrangeTimeline(combined.nodes, combined.edges, false);
  const baseline = arrangeTimeline(chapters, chapterEdges, false);
  assert.equal(combined.nodes.length, 6);
  assert.equal(combined.edges.filter((edge) => edge.id.startsWith("overview-parent:")).length, 3);
  assert.equal(combined.edges.find((edge) => edge.to === "event" && edge.kind === "contains")?.state, "held");
  assert.ok(combined.edges.some((edge) => edge.from === "person" && edge.to === "dialogue"));
  assert.ok(combined.edges.every((edge) => combined.nodes.some((node) => node.id === edge.from) && combined.nodes.some((node) => node.id === edge.to)));
  assert.deepEqual(result.tracks, baseline.tracks);
  for (const chapter of baseline.nodes) assert.deepEqual(result.nodes.find((node) => node.id === chapter.id)?.lanePos, chapter.lanePos);
  const positions = result.nodes.filter((node) => node.parent).map((node) => node.lanePos);
  assert.equal(new Set(positions.map((position) => position.join(","))).size, 3);
  assert.deepEqual({ chapters, chapterEdges, ghosts, activityEdges }, original);
  const afterMerge = withOverviewActivity(chapters, chapterEdges, ghosts.map((node) => node.state === "held" ? node : { ...node, state: "canon" }), activityEdges);
  assert.equal(afterMerge.nodes.find((node) => node.id === "person")?.state, "canon");
  assert.equal(afterMerge.edges.find((edge) => edge.id === "overview-parent:event")?.state, "held");
});
