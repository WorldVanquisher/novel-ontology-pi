/**
 * Schema v1 for the embedded Ladybug graph store.
 *
 * Ladybug (formerly Kuzu) uses a CLOSED schema: node/relation tables, typed
 * columns and primary keys must be declared up front. Adding a node or
 * relation type later is a CLI migration, never an improvisation.
 *
 * The JSONL bundle is the portable source of truth; this schema describes
 * the hot query engine rebuilt from it (`novel graph build`).
 */

export const SCHEMA_VERSION = 1;

export const LADYBUG_DDL: string[] = [
  `CREATE NODE TABLE IF NOT EXISTS Character(
     id STRING, canonical_name STRING, importance DOUBLE,
     embedding FLOAT[], PRIMARY KEY(id))`,
  `CREATE NODE TABLE IF NOT EXISTS Location(
     id STRING, canonical_name STRING, embedding FLOAT[], PRIMARY KEY(id))`,
  `CREATE NODE TABLE IF NOT EXISTS Organization(
     id STRING, canonical_name STRING, PRIMARY KEY(id))`,
  `CREATE NODE TABLE IF NOT EXISTS Item(
     id STRING, canonical_name STRING, PRIMARY KEY(id))`,
  `CREATE NODE TABLE IF NOT EXISTS Concept(
     id STRING, canonical_name STRING, embedding FLOAT[], PRIMARY KEY(id))`,
  `CREATE NODE TABLE IF NOT EXISTS Event(
     id STRING, timeline_id STRING, chapter_index INT64,
     chronological_order INT64, event_type STRING, summary_en STRING,
     importance DOUBLE, embedding FLOAT[], PRIMARY KEY(id))`,
  `CREATE NODE TABLE IF NOT EXISTS Scene(
     id STRING, chapter_index INT64, PRIMARY KEY(id))`,
  `CREATE NODE TABLE IF NOT EXISTS Timeline(
     id STRING, label STRING, PRIMARY KEY(id))`,
  `CREATE NODE TABLE IF NOT EXISTS Branch(
     id STRING, parent_timeline_id STRING, fork_event_id STRING,
     label STRING, PRIMARY KEY(id))`,

  // Relations (endpoint pairs are fixed by the closed schema).
  `CREATE REL TABLE IF NOT EXISTS CAUSES(FROM Event TO Event, confidence DOUBLE)`,
  `CREATE REL TABLE IF NOT EXISTS CAUSED_BY(FROM Event TO Event, confidence DOUBLE)`,
  `CREATE REL TABLE IF NOT EXISTS PARTICIPATES_IN(FROM Character TO Event, role STRING)`,
  `CREATE REL TABLE IF NOT EXISTS PRESENT_IN(FROM Character TO Scene)`,
  `CREATE REL TABLE IF NOT EXISTS MENTIONED_IN(FROM Character TO Scene)`,
  `CREATE REL TABLE IF NOT EXISTS LOCATED_AT(FROM Scene TO Location)`,
  `CREATE REL TABLE IF NOT EXISTS KNOWS(FROM Character TO Character, degree DOUBLE)`,
  `CREATE REL TABLE IF NOT EXISTS SPEAKS_TO(FROM Character TO Character, scene_id STRING)`,
  `CREATE REL TABLE IF NOT EXISTS OWNS(FROM Character TO Item)`,
  `CREATE REL TABLE IF NOT EXISTS MEMBER_OF(FROM Character TO Organization)`,
  `CREATE REL TABLE IF NOT EXISTS STATE_BEFORE(FROM Character TO Event)`,
  `CREATE REL TABLE IF NOT EXISTS STATE_AFTER(FROM Character TO Event)`,
  `CREATE REL TABLE IF NOT EXISTS FORKS_FROM(FROM Branch TO Event)`,
  `CREATE REL TABLE IF NOT EXISTS PRECEDES(FROM Event TO Event)`,
];

/** Full-text + vector index creation happens in `novel graph reindex`. */
export const INDEX_NOTES = [
  "FTS (BM25) index over Event.summary_en and Character.canonical_name",
  "Vector index (HNSW, cosine) over Event.embedding / Character.embedding / Scene content",
  "Embedding dimension is fixed at index creation and recorded in the",
  "bundle manifest; changing the embedding model requires a reindex.",
];
