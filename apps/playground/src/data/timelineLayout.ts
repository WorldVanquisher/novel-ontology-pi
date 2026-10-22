import type { WorldEdge, WorldNode } from "../types.js";

export interface TimelineTrack {
  id: string;
  label: string;
  lane: WorldNode["lane"];
  start: [number, number, number];
  end: [number, number, number];
}

export function arrangeTimeline(nodes: WorldNode[], edges: WorldEdge[], interior: boolean): { nodes: WorldNode[]; tracks: TimelineTrack[] } {
  const groups: { id: string; label: string; lane: WorldNode["lane"]; records: WorldNode[] }[] = [];
  const attached = new Set(interior ? [] : nodes.filter((node) => node.parent && nodes.some((parent) => parent.id === node.parent && !parent.parent)).map((node) => node.id));
  if (!interior) {
    for (const lane of ["canon", "branch"] as const) {
      const records = nodes.filter((node) => node.lane === lane && !attached.has(node.id)).sort((first, second) => first.chrono - second.chrono);
      if (records.length) groups.push({ id: lane, label: lane === "canon" ? "Canon" : "Branch", lane, records });
    }
  } else {
    const remaining = new Set(nodes.filter((node) => node.kind !== "character").map((node) => node.id));
    while (remaining.size) {
      const first = remaining.values().next().value as string;
      const component = new Set([first]);
      const queue = [first];
      remaining.delete(first);
      for (let cursor = 0; cursor < queue.length; cursor++) {
        for (const edge of edges) {
          if (edge.kind !== "flow" && edge.kind !== "contains") continue;
          const neighbor = edge.from === queue[cursor] ? edge.to : edge.to === queue[cursor] ? edge.from : null;
          if (neighbor && remaining.delete(neighbor)) { component.add(neighbor); queue.push(neighbor); }
        }
      }
      const records = nodes.filter((node) => component.has(node.id)).sort((left, right) => left.chrono - right.chrono);
      const place = records.find((node) => node.kind === "location") ?? records[0];
      groups.push({ id: place.id, label: place.label, lane: place.lane, records });
    }
  }
  const coordinates = new Map<string, [number, number, number]>();
  const tracks: TimelineTrack[] = [];
  const step = interior ? 120 : 210;
  const rowSpacing = interior ? 190 : 230;
  groups.forEach((group, index) => {
    const vertical = ((groups.length - 1) / 2 - index) * rowSpacing;
    let offset = 0;
    if (!interior && group.lane === "branch") {
      const fork = edges.find((edge) => edge.kind === "cross" && group.records.some((node) => node.id === edge.to));
      const source = nodes.find((node) => node.id === fork?.from);
      const target = group.records.find((node) => node.id === fork?.to);
      if (source && target) offset = source.chrono - target.chrono;
    }
    for (const node of group.records) coordinates.set(node.id, [(node.chrono + offset) * step, vertical, 0]);
    const horizontal = group.records.map((node) => coordinates.get(node.id)![0]);
    const source = edges.find((edge) => edge.kind === "cross" && group.records.some((node) => node.id === edge.to));
    const forkLabel = !interior && source ? nodes.find((node) => node.id === source.from)?.label : null;
    tracks.push({ id: group.id, label: `${String(index + 1).padStart(2, "0")} / ${group.label}${forkLabel ? ` · from ${forkLabel}` : ""}`, lane: group.lane, start: [Math.min(...horizontal) - 70, vertical, -15], end: [Math.max(...horizontal) + 85, vertical, -15] });
  });
  const attachments = new Map<string, number>();
  for (const node of nodes.filter((record) => attached.has(record.id))) {
    const parent = coordinates.get(node.parent!)!;
    const slot = attachments.get(node.parent!) ?? 0;
    attachments.set(node.parent!, slot + 1);
    coordinates.set(node.id, [parent[0] + (slot % 3 - 1) * 92, parent[1] + 100 + Math.floor(slot / 3) * 65, 30]);
  }
  const occupied = new Map<string, number>();
  for (const character of nodes.filter((node) => node.kind === "character")) {
    if (attached.has(character.id)) continue;
    const references = edges.filter((edge) => edge.from === character.id || edge.to === character.id)
      .map((edge) => nodes.find((node) => node.id === (edge.from === character.id ? edge.to : edge.from)))
      .filter((node): node is WorldNode => !!node && coordinates.has(node.id))
      .sort((first, second) => first.chrono - second.chrono);
    const anchor = references[0];
    const position = anchor ? coordinates.get(anchor.id)! : [character.chrono * step, 0, 0];
    const key = `${position[0]}|${position[1]}`;
    const level = occupied.get(key) ?? 0;
    occupied.set(key, level + 1);
    coordinates.set(character.id, [position[0], position[1] + 82 + level * 48, 12]);
  }
  const horizontal = [...coordinates.entries()].filter(([id]) => !attached.has(id)).map(([, position]) => position[0]);
  const center = horizontal.length ? (Math.min(...horizontal) + Math.max(...horizontal)) / 2 : 0;
  return {
    nodes: nodes.map((node) => {
      const position = coordinates.get(node.id) ?? [0, 0, 0];
      const centered: [number, number, number] = [position[0] - center, position[1], position[2]];
      return { ...node, ...(interior ? { interiorPos: centered } : { lanePos: centered }) };
    }),
    tracks: tracks.map((track) => ({ ...track, start: [track.start[0] - center, track.start[1], track.start[2]], end: [track.end[0] - center, track.end[1], track.end[2]] })),
  };
}

export function withOverviewActivity(laneNodes: WorldNode[], laneEdges: WorldEdge[], activityNodes: WorldNode[], activityEdges: WorldEdge[]): { nodes: WorldNode[]; edges: WorldEdge[] } {
  const nodes = [...laneNodes, ...activityNodes];
  const ids = new Set(nodes.map((node) => node.id));
  const edges = [...laneEdges, ...activityEdges].filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  for (const node of activityNodes) {
    if (!node.parent || !ids.has(node.parent) || edges.some((edge) => edge.from === node.parent && edge.to === node.id)) continue;
    edges.push({ id: `overview-parent:${node.id}`, from: node.parent, to: node.id, kind: "contains", state: node.state, parent: node.parent });
  }
  return { nodes, edges };
}
