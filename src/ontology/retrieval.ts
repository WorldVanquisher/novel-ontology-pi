import type { LadybugStore } from "../connectors/ladybug.js";
import type { Entity, OntEvent } from "./types.js";

/**
 * Graph-only retrieval — the Phase 1 experiment.
 *
 * Every information need that extraction and simulation have of the
 * ontology is expressed here as relational Cypher traversal over the
 * Ladybug store. The standing decision (2026-10-21) is: NO embedding
 * model until these provably can't satisfy a real need. If one of these
 * ever falls short, that failure — named and concrete — is what justifies
 * adding vectors, and it gets recorded on the roadmap.
 */

function clampDepth(depth: number): number {
  return Math.max(1, Math.min(8, Math.floor(depth)));
}

/** Who is physically in a scene (present, not merely mentioned). */
export async function charactersPresent(
  store: LadybugStore,
  sceneId: string,
): Promise<Entity[]> {
  const rows = await store.run(
    `MATCH (c:Character)-[:PRESENT_IN]->(s:Scene {id: $id})
     RETURN c.id AS id`,
    { id: sceneId },
  );
  const out: Entity[] = [];
  for (const r of rows) {
    const e = await store.getEntity(r.id as string);
    if (e) out.push(e);
  }
  return out;
}

/** Characters who share at least one scene with the given character. */
export async function coPresentCharacters(
  store: LadybugStore,
  characterId: string,
): Promise<Entity[]> {
  const rows = await store.run(
    `MATCH (c:Character {id: $id})-[:PRESENT_IN]->(s:Scene)<-[:PRESENT_IN]-(other:Character)
     WHERE other.id <> $id
     RETURN DISTINCT other.id AS id`,
    { id: characterId },
  );
  const out: Entity[] = [];
  for (const r of rows) {
    const e = await store.getEntity(r.id as string);
    if (e) out.push(e);
  }
  return out;
}

/** A character's event stream, in story order — the input to state folding. */
export async function characterEventStream(
  store: LadybugStore,
  characterId: string,
): Promise<OntEvent[]> {
  const rows = await store.run(
    `MATCH (c:Character {id: $id})-[:PARTICIPATES_IN]->(e:Event)
     RETURN e.timeline_id AS timeline_id
     ORDER BY e.chronological_order LIMIT 1`,
    { id: characterId },
  );
  if (!rows.length) return [];
  const all = await store.listEvents(rows[0].timeline_id as string, 0);
  const mine = await store.run(
    `MATCH (c:Character {id: $id})-[:PARTICIPATES_IN]->(e:Event)
     RETURN e.id AS id`,
    { id: characterId },
  );
  const ids = new Set(mine.map((r) => r.id as string));
  return all.filter((e) => ids.has(e.id));
}

/** Everything that (transitively) caused an event — causal ancestors. */
export async function causalAncestors(
  store: LadybugStore,
  eventId: string,
  depth = 4,
): Promise<string[]> {
  const rows = await store.run(
    `MATCH (cause:Event)-[:CAUSES*1..${clampDepth(depth)}]->(e:Event {id: $id})
     RETURN DISTINCT cause.id AS id`,
    { id: eventId },
  );
  return rows.map((r) => r.id as string);
}

/** Everything an event (transitively) causes — causal descendants. */
export async function causalDescendants(
  store: LadybugStore,
  eventId: string,
  depth = 4,
): Promise<string[]> {
  const rows = await store.run(
    `MATCH (e:Event {id: $id})-[:CAUSES*1..${clampDepth(depth)}]->(effect:Event)
     RETURN DISTINCT effect.id AS id`,
    { id: eventId },
  );
  return rows.map((r) => r.id as string);
}

/** Where a scene happens (null if the location was never resolved). */
export async function sceneLocation(
  store: LadybugStore,
  sceneId: string,
): Promise<Entity | null> {
  const rows = await store.run(
    `MATCH (s:Scene {id: $id})-[:LOCATED_AT]->(l:Location)
     RETURN l.id AS id LIMIT 1`,
    { id: sceneId },
  );
  if (!rows.length) return null;
  return store.getEntity(rows[0].id as string);
}

/** Candidate fork points: the events a user would plausibly fork at. */
export async function forkPoints(
  store: LadybugStore,
  timelineId: string,
  minImportance = 0.5,
): Promise<OntEvent[]> {
  return store.listEvents(timelineId, minImportance);
}
