import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventSink } from "../events/types.js";
import { Database, Connection } from "@ladybugdb/core";
import type { QueryResult } from "@ladybugdb/core";
import type { OntologyStore } from "../ontology/store.js";
import { LADYBUG_DDL } from "../ontology/schema.js";
import type {
  Branch,
  CharacterStateAtPoint,
  Entity,
  EntityKind,
  OntEvent,
  Relation,
  RelationType,
  Scene,
} from "../ontology/types.js";

/**
 * LadybugStore — the hot query engine (embedded property graph + Cypher).
 *
 * Ladybug (formerly Kuzu) is an in-process graph database: one `.lbug`
 * file, no server, no Docker. Phase 1 is GRAPH-FIRST (decision
 * 2026-10-21): retrieval is relational Cypher traversal; there are no
 * embedding columns and no vector/FTS indexes until Cypher is proven
 * insufficient for what extraction and simulation actually need.
 *
 * The store is rebuilt FROM the bundle (`novel graph build`); it is a
 * disposable cache, never the source of truth. One writer + many readers
 * matches the CLI's access pattern: ingest writes, queries read.
 */

type Row = Record<string, unknown>;

const NAME_TABLES: EntityKind[] = [
  "Character",
  "Location",
  "Organization",
  "Item",
  "Concept",
];
const ALL_TABLES: EntityKind[] = [
  ...NAME_TABLES,
  "Event",
  "Scene",
  "Timeline",
  "Branch",
];

/** Fixed endpoint labels + writable properties per relation table (schema v1). */
const REL_DEFS: Partial<
  Record<RelationType, { from: EntityKind; to: EntityKind; props: string[] }>
> = {
  CAUSES: { from: "Event", to: "Event", props: ["confidence"] },
  CAUSED_BY: { from: "Event", to: "Event", props: ["confidence"] },
  PARTICIPATES_IN: { from: "Character", to: "Event", props: ["role"] },
  PRESENT_IN: { from: "Character", to: "Scene", props: [] },
  MENTIONED_IN: { from: "Character", to: "Scene", props: [] },
  LOCATED_AT: { from: "Scene", to: "Location", props: [] },
  KNOWS: { from: "Character", to: "Character", props: ["degree"] },
  SPEAKS_TO: { from: "Character", to: "Character", props: ["scene_id"] },
  OWNS: { from: "Character", to: "Item", props: [] },
  MEMBER_OF: { from: "Character", to: "Organization", props: [] },
  STATE_BEFORE: { from: "Character", to: "Event", props: [] },
  STATE_AFTER: { from: "Character", to: "Event", props: [] },
  FORKS_FROM: { from: "Branch", to: "Event", props: [] },
  PRECEDES: { from: "Event", to: "Event", props: [] },
  // ADDRESSES has no table in schema v1 — see addRelation.
};

function canonicalName(e: Entity): string {
  const n =
    e.names.find((x) => x.kind === "canonical") ?? e.names[0];
  return n ? n.text : e.id;
}

export class LadybugStore implements OntologyStore {
  private db: Database;
  private conn: Connection;
  private schemaReady = false;

  constructor(private dbPath: string) {
    this.db = new Database(dbPath);
    this.conn = new Connection(this.db);
  }

  /** Apply schema v1 DDL (idempotent). Called by graph build / first write. */
  async initSchema(): Promise<void> {
    if (this.schemaReady) return;
    for (const ddl of LADYBUG_DDL) await this.run(ddl);
    this.schemaReady = true;
  }

  /** Run Cypher; params go through a prepared statement, never string glue. */
  async run(cypher: string, params?: Record<string, unknown>): Promise<Row[]> {
    const collect = async (
      res: QueryResult | QueryResult[],
    ): Promise<Row[]> => {
      const results = Array.isArray(res) ? res : [res];
      try {
        return (await results[0].getAll()) as Row[];
      } finally {
        // Results retain native connection resources even after getAll().
        for (const result of results) result.close();
      }
    };
    if (!params) return collect(await this.conn.query(cypher));
    const prep = await this.conn.prepare(cypher);
    return collect(
      await this.conn.execute(
        prep,
        params as Record<string, never>,
      ),
    );
  }

  /** Normalize `RETURN n.*` rows: Ladybug keys them "n.id", we want "id". */
  private props(rows: Row[]): Row[] {
    return rows.map((r) => {
      const out: Row = {};
      for (const [k, v] of Object.entries(r)) {
        out[k.includes(".") ? k.slice(k.indexOf(".") + 1) : k] = v;
      }
      return out;
    });
  }

  async close(): Promise<void> {
    try {
      await this.conn.close();
    } finally {
      // Each store owns its Database. Closing only the connection leaves old
      // instances alive when graph build opens this path again.
      await this.db.close();
    }
  }

  // ---------------- writes (approved merges + graph build only) ----------

  async upsertEntity(e: Entity): Promise<void> {
    await this.initSchema();
    if (e.kind === "Event") throw new Error("Use upsertEvent for events.");
    if (e.kind === "Scene") throw new Error("Use upsertScene for scenes.");
    if (e.kind === "Branch") {
      await this.createBranch({
        id: e.id,
        parentTimelineId: String(e.properties.parentTimelineId ?? ""),
        forkEventId: String(e.properties.forkEventId ?? ""),
        label: canonicalName(e),
      });
      return;
    }
    if (e.kind === "Timeline") {
      await this.run(
        `MERGE (n:Timeline {id: $id}) SET n.label = $label`,
        { id: e.id, label: canonicalName(e) },
      );
      return;
    }
    await this.run(
      `MERGE (n:${e.kind} {id: $id})
       SET n.canonical_name = $name${e.kind === "Character" ? ", n.importance = $importance" : ""}`,
      {
        id: e.id,
        name: canonicalName(e),
        ...(e.kind === "Character"
          ? { importance: Number(e.properties.importance ?? e.confidence ?? 0) }
          : {}),
      },
    );
  }

  async upsertEvent(ev: OntEvent): Promise<void> {
    await this.initSchema();
    await this.run(
      `MERGE (n:Event {id: $id})
       SET n.timeline_id = $timelineId, n.chapter_index = $chapterIndex,
           n.chronological_order = $ord, n.event_type = $etype,
           n.summary_en = $summary, n.importance = $importance`,
      {
        id: ev.id,
        timelineId: ev.timelineId,
        chapterIndex: ev.chapterIndex,
        ord: ev.chronologicalOrder,
        etype: ev.eventType,
        summary: ev.summaryEn,
        importance: ev.importance,
      },
    );
    for (const actorId of ev.primaryActors) {
      await this.addRelation({
        fromId: actorId,
        toId: ev.id,
        type: "PARTICIPATES_IN",
        properties: { role: "primary" },
        confidence: ev.confidence,
      }).catch(() => undefined); // actor may land in a later ChangeSet
    }
  }

  async upsertScene(s: Scene): Promise<void> {
    await this.initSchema();
    await this.run(
      `MERGE (n:Scene {id: $id}) SET n.chapter_index = $chapterIndex`,
      { id: s.id, chapterIndex: s.chapterIndex },
    );
    for (const cid of s.charactersPresent) {
      await this.addRelation({
        fromId: cid, toId: s.id, type: "PRESENT_IN", properties: {}, confidence: 1,
      }).catch(() => undefined);
    }
    for (const cid of s.charactersMentioned) {
      await this.addRelation({
        fromId: cid, toId: s.id, type: "MENTIONED_IN", properties: {}, confidence: 1,
      }).catch(() => undefined);
    }
    if (s.locationId) {
      await this.addRelation({
        fromId: s.id, toId: s.locationId, type: "LOCATED_AT", properties: {}, confidence: 1,
      }).catch(() => undefined);
    }
  }

  async addRelation(r: Relation): Promise<void> {
    await this.initSchema();
    const def = REL_DEFS[r.type];
    if (!def) {
      throw new Error(
        `Relation ${r.type} has no table in schema v1 (it is carried in the bundle JSONL only).`,
      );
    }
    const valueOf = (p: string): unknown =>
      p === "confidence"
        ? (r.properties.confidence ?? r.confidence)
        : r.properties[p];
    const propNames = def.props.filter((p) => valueOf(p) !== undefined);
    const propClause = propNames.length
      ? ` {${propNames.map((p) => `${p}: $${p}`).join(", ")}}`
      : "";
    const params: Record<string, unknown> = { fromId: r.fromId, toId: r.toId };
    for (const p of propNames) params[p] = valueOf(p);
    await this.run(
      `MATCH (a:${def.from} {id: $fromId}), (b:${def.to} {id: $toId})
       CREATE (a)-[:${r.type}${propClause}]->(b)`,
      params,
    );
  }

  async createBranch(b: Branch): Promise<void> {
    await this.initSchema();
    await this.run(
      `MERGE (n:Branch {id: $id})
       SET n.parent_timeline_id = $parent, n.fork_event_id = $fork, n.label = $label`,
      { id: b.id, parent: b.parentTimelineId, fork: b.forkEventId, label: b.label },
    );
    await this.addRelation({
      fromId: b.id, toId: b.forkEventId, type: "FORKS_FROM", properties: {}, confidence: 1,
    }).catch(() => undefined);
  }

  // ---------------- reads -------------------------------------------------

  private rowToEntity(kind: EntityKind, row: Row): Entity {
    const name = (row.canonical_name ?? row.label ?? row.id) as string;
    return {
      id: row.id as string,
      kind,
      names: [{ text: name, lang: "", kind: "canonical" }],
      properties: { ...row },
      confidence: 1,
    };
  }

  async getEntity(id: string): Promise<Entity | null> {
    for (const table of ALL_TABLES) {
      const rows = this.props(
        await this.run(`MATCH (n:${table} {id: $id}) RETURN n.*`, { id }),
      );
      if (rows.length) return this.rowToEntity(table, rows[0]);
    }
    return null;
  }

  async findByName(text: string): Promise<Entity[]> {
    const hits: Entity[] = [];
    for (const table of NAME_TABLES) {
      const exact = this.props(
        await this.run(
          `MATCH (n:${table}) WHERE n.canonical_name = $text RETURN n.*`,
          { text },
        ),
      );
      const rows = exact.length
        ? exact
        : this.props(
            await this.run(
              `MATCH (n:${table}) WHERE n.canonical_name CONTAINS $text RETURN n.*`,
              { text },
            ),
          );
      for (const r of rows) hits.push(this.rowToEntity(table, r));
    }
    return hits;
  }

  async traverse(
    fromId: string,
    relation: string,
    depth: number,
  ): Promise<Entity[]> {
    const rel = relation.toUpperCase();
    if (!REL_DEFS[rel as RelationType] && rel !== "ADDRESSES") {
      throw new Error(`Unknown relation type: ${relation}`);
    }
    const d = Math.max(1, Math.min(5, Math.floor(depth)));
    const rows = await this.run(
      `MATCH (a {id: $id})-[r:${rel}*1..${d}]-(b) RETURN DISTINCT b.id AS id`,
      { id: fromId },
    );
    const out: Entity[] = [];
    for (const r of rows) {
      const e = await this.getEntity(r.id as string);
      if (e && e.id !== fromId) out.push(e);
    }
    return out;
  }

  /**
   * Graph-first text search: a Cypher CONTAINS scan over canonical names
   * and event summaries. Honest stand-in until/unless the deferred FTS
   * index is justified (see schema.ts INDEX_NOTES).
   */
  async searchText(query: string, limit: number): Promise<Entity[]> {
    const byName = await this.findByName(query);
    const events = this.props(
      await this.run(
        `MATCH (n:Event) WHERE n.summary_en CONTAINS $q
         RETURN n.* ORDER BY n.importance DESC LIMIT ${Math.max(1, limit)}`,
        { q: query },
      ),
    );
    const seen = new Set(byName.map((e) => e.id));
    const out = [...byName];
    for (const r of events) {
      if (!seen.has(r.id as string)) out.push(this.rowToEntity("Event", r));
    }
    return out.slice(0, Math.max(1, limit));
  }

  async searchVector(_embedding: number[], _limit: number): Promise<Entity[]> {
    throw new Error(
      "Vector search is DEFERRED (decision 2026-10-21): graph-first until relational Cypher is proven insufficient.",
    );
  }

  async getStateAt(): Promise<CharacterStateAtPoint | null> {
    throw new Error(
      "State folding lands with the extraction step (state deltas are not in the graph yet).",
    );
  }

  async listEvents(timelineId: string, minImportance: number): Promise<OntEvent[]> {
    const rows = this.props(
      await this.run(
        `MATCH (n:Event)
         WHERE n.timeline_id = $t AND n.importance >= $m
         RETURN n.* ORDER BY n.chronological_order`,
        { t: timelineId, m: minImportance },
      ),
    );
    // The graph stores the queryable projection; evidence/actors live in
    // the bundle JSONL (the complete record). See DESIGN.md storage split.
    return rows.map((r) => ({
      id: r.id as string,
      timelineId: r.timeline_id as string,
      chapterIndex: Number(r.chapter_index),
      chronologicalOrder: Number(r.chronological_order),
      eventType: r.event_type as OntEvent["eventType"],
      summaryEn: r.summary_en as string,
      evidence: { text: "", sentenceIds: [] },
      importance: Number(r.importance),
      primaryActors: [],
      affectedCharacters: [],
      confidence: 1,
    }));
  }
}

/**
 * Rebuild the Ladybug store from a bundle directory (the source of truth).
 * Used by `novel graph build` and after every approved merge.
 */
export async function buildGraphFromBundle(
  bundleDir: string,
  dbPath: string,
  emit?: EventSink,
): Promise<{ entities: number; events: number; scenes: number; relations: number; branches: number }> {
  // BundleStore.loadFile currently swallows all read/parse errors. A successful
  // rebuild fact must not hide corruption or an I/O failure.
  const load = async <T>(name: string): Promise<T[]> => {
    let raw: string;
    try { raw = await readFile(join(bundleDir, name), "utf8"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
    return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
  };
  const store = new LadybugStore(dbPath);
  let counts;
  try {
    await store.initSchema();

    // The bundle is an append log: consumers fold by id, last write
    // wins (an alias fold or a fix appends a fresh row for an existing
    // entity). Fold here too — inserting and counting raw rows would
    // double-count every updated record.
    const foldById = <T extends { id: string }>(rows: T[]): T[] => {
      const byId = new Map<string, T>();
      for (const r of rows) byId.set(r.id, r);
      return [...byId.values()];
    };
    const entities = foldById([
      ...(await load<Entity>("entities.jsonl")),
      ...(await load<Entity>("timelines.jsonl")),
    ]);
    for (const e of entities) await store.upsertEntity(e);
    const events = foldById(await load<OntEvent>("events.jsonl"));
    for (const ev of events) await store.upsertEvent(ev);
    const scenes = foldById(await load<Scene>("scenes.jsonl"));
    for (const s of scenes) await store.upsertScene(s);
    const relations = await load<Relation>("relations.jsonl");
    let relApplied = 0;
    for (const r of relations) {
      // Only schema-unsupported types stay bundle-only. I/O/query failures fail
      // the build instead of generating a false graph.rebuilt success event.
      if (!REL_DEFS[r.type]) continue;
      await store.addRelation(r);
      relApplied++;
    }
    const branches = await load<Branch>("branches.jsonl");
    for (const b of branches) await store.createBranch(b);
    counts = {
      entities: entities.length,
      events: events.length,
      scenes: scenes.length,
      relations: relApplied,
      branches: branches.length,
    };
  } finally { await store.close(); }
  await emit?.({ type: "graph.rebuilt", counts });
  return counts;
}
