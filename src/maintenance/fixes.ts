import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BundleStore } from "../connectors/bundle.js";
import type {
  Entity,
  NameForm,
  OntEvent,
  Relation,
  RelationType,
  Scene,
} from "../ontology/types.js";

/**
 * Pointwise fixes — the reviewing agent's maintenance tools over the
 * bundle (sector 09). The merge gate works on whole ChangeSets; these
 * work on single facts: merge two entities, rename one, add a name
 * form, relate/unrelate, remove a record.
 *
 * Rules:
 *  - The bundle stays the source of truth. Entity edits append an
 *    upsert row (the bundle's own fold semantics); structural files
 *    (relations/events/scenes) are surgically rewritten only when an
 *    id must move or disappear.
 *  - EVERY fix appends an audit entry to <novelDir>/maintenance.jsonl
 *    — canon never changes without a trace of who changed it and why.
 *  - The caller rebuilds the graph afterwards (fixCommands does).
 */

export interface AuditEntry {
  ts: string;
  op: string;
  args: Record<string, unknown>;
  reason: string | null;
  actor: "agent";
}

export async function appendAudit(
  novelDir: string,
  op: string,
  args: Record<string, unknown>,
  reason?: string,
): Promise<void> {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    op,
    args,
    reason: reason ?? null,
    actor: "agent",
  };
  await mkdir(novelDir, { recursive: true });
  await appendFile(
    join(novelDir, "maintenance.jsonl"),
    JSON.stringify(entry) + "\n",
  );
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

function ontologyDir(novelDir: string): string {
  return join(novelDir, "ontology");
}

async function loadEntity(novelDir: string, id: string): Promise<Entity> {
  const store = new BundleStore(ontologyDir(novelDir));
  const rows = await store.loadFile<Entity>("entities.jsonl");
  let found: Entity | null = null;
  for (const e of rows) if (e.id === id) found = e;
  if (!found) throw new Error(`No entity ${id} in ${novelDir}.`);
  return found;
}

const dedupe = <T,>(xs: T[]): T[] => [...new Set(xs)];

export async function mergeEntities(
  novelDir: string,
  keepId: string,
  dropId: string,
  reason?: string,
): Promise<{ keepId: string; dropId: string; rewired: { relations: number; events: number; scenes: number } }> {
  if (keepId === dropId) throw new Error("keep and drop are the same entity.");
  const keep = await loadEntity(novelDir, keepId);
  const drop = await loadEntity(novelDir, dropId);
  const dir = ontologyDir(novelDir);

  const merged: Entity = {
    ...keep,
    names: [
      ...keep.names,
      ...drop.names.filter((dn) => !keep.names.some((kn) => kn.text === dn.text)),
    ],
    properties: { ...drop.properties, ...keep.properties },
    confidence: Math.max(keep.confidence, drop.confidence),
  };

  // Entities: drop's rows disappear; the merged keep row is appended
  // (fold semantics make it authoritative).
  const entityRows = await readJsonl<Entity>(join(dir, "entities.jsonl"));
  await writeJsonl(
    join(dir, "entities.jsonl"),
    entityRows.filter((e) => e.id !== dropId),
  );
  await new BundleStore(dir).upsertEntity(merged);

  const remap = (id: string) => (id === dropId ? keepId : id);

  const relations = await readJsonl<Relation>(join(dir, "relations.jsonl"));
  const seenRel = new Set<string>();
  const newRelations: Relation[] = [];
  let rewiredRelations = 0;
  for (const r of relations) {
    const fromId = remap(r.fromId), toId = remap(r.toId);
    if (fromId !== r.fromId || toId !== r.toId) rewiredRelations++;
    if (fromId === toId) continue; // a self-loop created by the merge is meaningless
    const key = `${fromId}|${toId}|${r.type}`;
    if (seenRel.has(key)) continue;
    seenRel.add(key);
    newRelations.push({ ...r, fromId, toId });
  }
  await writeJsonl(join(dir, "relations.jsonl"), newRelations);

  const events = await readJsonl<OntEvent>(join(dir, "events.jsonl"));
  let rewiredEvents = 0;
  for (const e of events) {
    const before = JSON.stringify([e.primaryActors, e.affectedCharacters]);
    e.primaryActors = dedupe(e.primaryActors.map(remap));
    e.affectedCharacters = dedupe(e.affectedCharacters.map(remap));
    if (JSON.stringify([e.primaryActors, e.affectedCharacters]) !== before) rewiredEvents++;
  }
  await writeJsonl(join(dir, "events.jsonl"), events);

  const scenes = await readJsonl<Scene>(join(dir, "scenes.jsonl"));
  let rewiredScenes = 0;
  for (const s of scenes) {
    const before = JSON.stringify(s);
    s.charactersPresent = dedupe(s.charactersPresent.map(remap));
    s.charactersMentioned = dedupe(s.charactersMentioned.map(remap)).filter((id) => !s.charactersPresent.includes(id));
    for (const t of s.turns) {
      if (t.speakerId) t.speakerId = remap(t.speakerId);
      if (t.addresseeId) t.addresseeId = remap(t.addresseeId);
    }
    if (s.locationId) s.locationId = remap(s.locationId);
    if (JSON.stringify(s) !== before) rewiredScenes++;
  }
  await writeJsonl(join(dir, "scenes.jsonl"), scenes);

  await appendAudit(novelDir, "merge", { keepId, dropId, foldedForms: drop.names.map((n) => n.text) }, reason);
  return { keepId, dropId, rewired: { relations: rewiredRelations, events: rewiredEvents, scenes: rewiredScenes } };
}

export async function renameEntity(
  novelDir: string,
  id: string,
  newCanonical: string,
  reason?: string,
): Promise<{ id: string; names: NameForm[] }> {
  const entity = await loadEntity(novelDir, id);
  const canonicalIdx = entity.names.findIndex((n) => n.kind === "canonical");
  const names = entity.names.map((n, i) =>
    i === (canonicalIdx >= 0 ? canonicalIdx : 0) ? { ...n, text: newCanonical } : n,
  );
  const oldText = entity.names[canonicalIdx >= 0 ? canonicalIdx : 0]?.text;
  if (oldText && oldText !== newCanonical && !names.some((n) => n.text === oldText)) {
    names.push({ text: oldText, lang: entity.names[0]?.lang ?? "und", kind: "alias" });
  }
  await new BundleStore(ontologyDir(novelDir)).upsertEntity({ ...entity, names });
  await appendAudit(novelDir, "rename", { id, from: oldText, to: newCanonical }, reason);
  return { id, names };
}

export async function addNameForm(
  novelDir: string,
  id: string,
  text: string,
  kind: NameForm["kind"] = "alias",
  reason?: string,
): Promise<{ id: string; names: NameForm[] }> {
  const entity = await loadEntity(novelDir, id);
  if (entity.names.some((n) => n.text === text)) return { id, names: entity.names };
  const names = [
    ...entity.names,
    { text, lang: entity.names[0]?.lang ?? "und", kind },
  ];
  await new BundleStore(ontologyDir(novelDir)).upsertEntity({ ...entity, names });
  await appendAudit(novelDir, "add-form", { id, text, kind }, reason);
  return { id, names };
}

export async function relate(
  novelDir: string,
  fromId: string,
  toId: string,
  type: RelationType,
  reason?: string,
): Promise<{ added: boolean }> {
  // Endpoints may be entities or events (CAUSES is event->event,
  // PARTICIPATES_IN is entity->event); both must exist somewhere.
  const dir = ontologyDir(novelDir);
  const entityRows = await readJsonl<Entity>(join(dir, "entities.jsonl"));
  const eventRows = await readJsonl<OntEvent>(join(dir, "events.jsonl"));
  const known = new Set([
    ...entityRows.map((e) => e.id),
    ...eventRows.map((e) => e.id),
  ]);
  if (!known.has(fromId)) throw new Error(`relate: unknown from id ${fromId}.`);
  if (!known.has(toId)) throw new Error(`relate: unknown to id ${toId}.`);
  const path = join(dir, "relations.jsonl");
  const relations = await readJsonl<Relation>(path);
  if (relations.some((r) => r.fromId === fromId && r.toId === toId && r.type === type)) {
    return { added: false };
  }
  relations.push({ fromId, toId, type, properties: {}, confidence: 1 });
  await writeJsonl(path, relations);
  await appendAudit(novelDir, "relate", { fromId, toId, type }, reason);
  return { added: true };
}

export async function unrelate(
  novelDir: string,
  fromId: string,
  toId: string,
  type: RelationType,
  reason?: string,
): Promise<{ removed: number }> {
  const path = join(ontologyDir(novelDir), "relations.jsonl");
  const relations = await readJsonl<Relation>(path);
  const kept = relations.filter(
    (r) => !(r.fromId === fromId && r.toId === toId && r.type === type),
  );
  const removed = relations.length - kept.length;
  if (removed > 0) {
    await writeJsonl(path, kept);
    await appendAudit(novelDir, "unrelate", { fromId, toId, type }, reason);
  }
  return { removed };
}

export async function removeEntity(
  novelDir: string,
  id: string,
  reason?: string,
): Promise<{ removed: string }> {
  await loadEntity(novelDir, id);
  const dir = ontologyDir(novelDir);
  const entityRows = await readJsonl<Entity>(join(dir, "entities.jsonl"));
  await writeJsonl(join(dir, "entities.jsonl"), entityRows.filter((e) => e.id !== id));
  const relations = await readJsonl<Relation>(join(dir, "relations.jsonl"));
  await writeJsonl(
    join(dir, "relations.jsonl"),
    relations.filter((r) => r.fromId !== id && r.toId !== id),
  );
  const events = await readJsonl<OntEvent>(join(dir, "events.jsonl"));
  for (const e of events) {
    e.primaryActors = e.primaryActors.filter((x) => x !== id);
    e.affectedCharacters = e.affectedCharacters.filter((x) => x !== id);
  }
  await writeJsonl(join(dir, "events.jsonl"), events);
  const scenes = await readJsonl<Scene>(join(dir, "scenes.jsonl"));
  for (const s of scenes) {
    s.charactersPresent = s.charactersPresent.filter((x) => x !== id);
    s.charactersMentioned = s.charactersMentioned.filter((x) => x !== id);
    if (s.locationId === id) s.locationId = null;
    for (const t of s.turns) {
      if (t.speakerId === id) t.speakerId = null;
      if (t.addresseeId === id) t.addresseeId = null;
    }
  }
  await writeJsonl(join(dir, "scenes.jsonl"), scenes);
  await appendAudit(novelDir, "remove-entity", { id }, reason);
  return { removed: id };
}

export async function removeEvent(
  novelDir: string,
  eventId: string,
  reason?: string,
): Promise<{ removed: string }> {
  const dir = ontologyDir(novelDir);
  const events = await readJsonl<OntEvent>(join(dir, "events.jsonl"));
  if (!events.some((e) => e.id === eventId)) {
    throw new Error(`No event ${eventId} in ${novelDir}.`);
  }
  await writeJsonl(join(dir, "events.jsonl"), events.filter((e) => e.id !== eventId));
  const relations = await readJsonl<Relation>(join(dir, "relations.jsonl"));
  await writeJsonl(
    join(dir, "relations.jsonl"),
    relations.filter((r) => r.fromId !== eventId && r.toId !== eventId),
  );
  await appendAudit(novelDir, "remove-event", { eventId }, reason);
  return { removed: eventId };
}
