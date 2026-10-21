import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LadybugStore } from "../connectors/ladybug.js";
import { forkPoints } from "../ontology/retrieval.js";
import type { Entity, OntEvent } from "../ontology/types.js";

/**
 * The read-only browsing commands: `novel query`, `novel search`,
 * `novel timeline list|show` (DESIGN.md §7).
 *
 * All three are thin CLI surfaces over the EXISTING store and retrieval
 * APIs — no new retrieval behavior lives here:
 * - query        → LadybugStore.run (raw Cypher through the OntologyStore)
 * - search       → LadybugStore.searchText (graph-first CONTAINS scan;
 *                  vector/FTS search stays deferred, see schema.ts)
 * - timeline list → Timeline nodes + per-timeline event counts (store.run,
 *                  the same pattern `novel graph stats` uses)
 * - timeline show → retrieval.forkPoints (events at/above an importance
 *                  floor, in the store's chronological order)
 *
 * Store location: the named forms in DESIGN.md §7 carry no path, so —
 * like `novel changeset … <novel-dir>` — each command takes the novel
 * workspace directory and opens its built graph at
 * `<novel-dir>/ontology/graph.lbug`. A missing graph is a clear error,
 * never a silently created empty database.
 *
 * Resource handling follows the merged Ladybug cleanup pattern: the
 * store releases every query result after reading (LadybugStore.run)
 * and close() closes the connection AND the database; every function
 * here closes its store in a `finally`, on success and on error alike.
 */

/** Default result cap for `novel search` when --limit is not given. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** Default importance floor for `novel timeline show` (forkPoints' own default). */
export const DEFAULT_MIN_IMPORTANCE = 0.5;

export interface NovelQueryResult {
  novelDir: string;
  dbPath: string;
  rows: Record<string, unknown>[];
}

export interface NovelSearchResult {
  novelDir: string;
  dbPath: string;
  query: string;
  limit: number;
  results: Entity[];
}

export interface TimelineSummary {
  id: string;
  label: string;
  eventCount: number;
}

export interface TimelineListResult {
  novelDir: string;
  dbPath: string;
  timelines: TimelineSummary[];
}

export interface TimelineShowResult {
  novelDir: string;
  dbPath: string;
  timeline: { id: string; label: string };
  minImportance: number;
  points: OntEvent[];
}

/**
 * Resolve the built graph for a novel workspace. Read commands must not
 * create a database as a side effect, so a missing graph.lbug is an
 * error naming the build command that produces it.
 */
async function graphDbPath(novelDir: string): Promise<string> {
  const dbPath = join(resolve(novelDir), "ontology", "graph.lbug");
  const found = await stat(dbPath).catch(() => null);
  if (!found) {
    throw new Error(
      `graph store not found for ${novelDir}: ${dbPath} — build it first with: novel graph build ${join(novelDir, "ontology")}`,
    );
  }
  return dbPath;
}

/** Open the novel's graph, run `fn`, and ALWAYS close the store. */
async function withStore<T>(
  novelDir: string,
  fn: (store: LadybugStore, dbPath: string) => Promise<T>,
): Promise<T> {
  const dbPath = await graphDbPath(novelDir);
  const store = new LadybugStore(dbPath);
  try {
    return await fn(store, dbPath);
  } finally {
    await store.close();
  }
}

/** `novel query <novel-dir> <cypher>` — raw Cypher via the OntologyStore. */
export async function novelQuery(
  novelDir: string,
  cypher: string,
): Promise<NovelQueryResult> {
  return withStore(novelDir, async (store, dbPath) => ({
    novelDir,
    dbPath,
    rows: await store.run(cypher),
  }));
}

/** `novel search <novel-dir> <text> [--limit N]` — graph-first text search. */
export async function novelSearch(
  novelDir: string,
  text: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<NovelSearchResult> {
  return withStore(novelDir, async (store, dbPath) => ({
    novelDir,
    dbPath,
    query: text,
    limit,
    results: await store.searchText(text, limit),
  }));
}

/** `novel timeline list <novel-dir>` — the workspace's timelines. */
export async function timelineList(
  novelDir: string,
): Promise<TimelineListResult> {
  return withStore(novelDir, async (store, dbPath) => {
    const timelineRows = await store.run(
      `MATCH (t:Timeline) RETURN t.id AS id, t.label AS label`,
    );
    const countRows = await store.run(
      `MATCH (e:Event) RETURN e.timeline_id AS timeline_id, count(e) AS event_count`,
    );
    const counts = new Map<string, number>();
    for (const r of countRows) {
      counts.set(r.timeline_id as string, Number(r.event_count ?? 0));
    }
    const timelines = timelineRows
      .map((r) => ({
        id: r.id as string,
        label: (r.label as string | null) ?? (r.id as string),
        eventCount: counts.get(r.id as string) ?? 0,
      }))
      // IDs are opaque; id order is only for stable, diffable output.
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { novelDir, dbPath, timelines };
  });
}

/**
 * `novel timeline show <novel-dir> <timeline-id> [--min-importance N]` —
 * the timeline's time points: its candidate fork points (retrieval
 * forkPoints — events with importance >= the floor, chronological).
 * Points are the graph projection: evidence and actor lists live in the
 * bundle JSONL, as documented on LadybugStore.listEvents.
 */
export async function timelineShow(
  novelDir: string,
  timelineId: string,
  minImportance: number = DEFAULT_MIN_IMPORTANCE,
): Promise<TimelineShowResult> {
  return withStore(novelDir, async (store, dbPath) => {
    const timeline = await store.getEntity(timelineId);
    if (!timeline || timeline.kind !== "Timeline") {
      throw new Error(
        `unknown timeline: ${timelineId} (in ${novelDir}) — list timelines with: novel timeline list ${novelDir}`,
      );
    }
    const points = await forkPoints(store, timelineId, minImportance);
    return {
      novelDir,
      dbPath,
      timeline: { id: timeline.id, label: timeline.names[0]?.text ?? timeline.id },
      minImportance,
      points,
    };
  });
}
