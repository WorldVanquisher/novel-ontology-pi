import type { OntologyStore } from "../ontology/store.js";
import type {
  Branch,
  CharacterStateAtPoint,
  Entity,
  OntEvent,
  Relation,
  Scene,
} from "../ontology/types.js";

/**
 * LadybugStore — the hot query engine (embedded property graph + Cypher).
 *
 * Ladybug (formerly Kuzu) is an in-process graph database: one `.lbug`
 * file, no server, no Docker. It provides, in the same engine:
 *   - Cypher graph traversal (causal chains, presence, timeline walks)
 *   - a native vector index (HNSW, cosine/L2) for semantic search
 *   - full-text search (BM25) for exact names/terms
 * Node package: @ladybugdb/core.
 *
 * This file is rebuilt FROM the bundle (`novel graph build`); it is a
 * disposable cache, never the source of truth. One writer + many
 * read-only readers matches the CLI's access pattern exactly:
 * the ingest pipeline writes, queries read.
 *
 * Skeleton: methods throw until @ladybugdb/core is added and the DDL in
 * ontology/schema.ts is applied. The interface is the contract.
 */
export class LadybugStore implements OntologyStore {
  constructor(private dbPath: string) {}

  private notWired(): never {
    throw new Error(
      `LadybugStore (${this.dbPath}) not wired yet: add @ladybugdb/core, apply schema v1 DDL, implement Cypher here.`,
    );
  }

  async upsertEntity(_e: Entity): Promise<void> {
    this.notWired();
  }
  async upsertEvent(_e: OntEvent): Promise<void> {
    this.notWired();
  }
  async upsertScene(_s: Scene): Promise<void> {
    this.notWired();
  }
  async addRelation(_r: Relation): Promise<void> {
    this.notWired();
  }
  async createBranch(_b: Branch): Promise<void> {
    this.notWired();
  }
  async getEntity(_id: string): Promise<Entity | null> {
    this.notWired();
  }
  async findByName(_text: string): Promise<Entity[]> {
    this.notWired();
  }
  async traverse(
    _fromId: string,
    _relation: string,
    _depth: number,
  ): Promise<Entity[]> {
    this.notWired();
  }
  async searchText(_query: string, _limit: number): Promise<Entity[]> {
    this.notWired();
  }
  async searchVector(_embedding: number[], _limit: number): Promise<Entity[]> {
    this.notWired();
  }
  async getStateAt(
    _characterId: string,
    _eventId: string,
  ): Promise<CharacterStateAtPoint | null> {
    this.notWired();
  }
  async listEvents(_timelineId: string, _minImportance: number): Promise<OntEvent[]> {
    this.notWired();
  }
}
