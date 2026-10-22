import type { WorldEdge, WorldNode } from "../types";

/** The playground read model, loaded from the local DB files. */
export interface LoadedWorld {
  laneNodes: WorldNode[];
  laneEdges: WorldEdge[];
  interiors: Record<string, { nodes: WorldNode[]; edges: WorldEdge[] }>;
  bigEventLabels: Record<string, string>;
}

/**
 * Loads the world from `public/db/novel/view.json` — a local file in
 * the simulated bundle directory, standing in for the CLI's future
 * playground query output. No external APIs.
 *
 * In the single-file build (tools/build-singlefile.mjs) the same JSON
 * is embedded in a <script id="db-view"> tag instead, so the page
 * works fully offline from one file.
 */
export async function loadWorld(url = "/db/novel/view.json"): Promise<LoadedWorld> {
  const embedded = document.getElementById("db-view")?.textContent;
  if (embedded) return JSON.parse(embedded) as LoadedWorld;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`view file ${url}: HTTP ${res.status}`);
  return (await res.json()) as LoadedWorld;
}
