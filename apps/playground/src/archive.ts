import type { WorldNode } from "./types";

export const KIND_LABEL: Record<WorldNode["kind"], string> = {
  bigEvent: "Event file", character: "Character", location: "Location",
  scene: "Scene", event: "Event", dialogue: "Dialogue",
};

export const KIND_COLOR: Record<WorldNode["kind"], string> = {
  bigEvent: "#9aaa7c", character: "#a79ab4", location: "#88aaa4",
  scene: "#8d9d88", event: "#9aaa7c", dialogue: "#c2a77b",
};

export function recordColor(node: WorldNode): string {
  if (node.state === "proposed") return "#c6a16b";
  if (node.state === "held") return "#819398";
  if (node.lane === "branch" && node.kind === "bigEvent") return "#b49a8b";
  return KIND_COLOR[node.kind];
}

export function recordStatus(node: WorldNode): string {
  if (node.state === "proposed") return "Proposed";
  if (node.state === "held") return "Held for review";
  return node.lane === "branch" ? "Branch record" : "Canon record";
}
