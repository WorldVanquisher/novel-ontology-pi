import { copyFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BundleStore } from "../connectors/bundle.js";
import type { Entity, OntEvent, Scene, Relation } from "../ontology/types.js";
import { appendAudit } from "../maintenance/fixes.js";
import { loadChangeSet, saveChangeSet } from "./changesetStore.js";

export interface ProposalRevision {
  dropProposalIds?: string[];
  removeEntityIds?: string[];
  sanitizeTypes?: boolean;
  retypeEntities?: { entityId: string; kind: Entity["kind"] }[];
  mentionedOnlyEntityIds?: string[];
}

export async function reviseProposals(novelDir: string, id: string, value: unknown, reason: string) {
  if (!reason.trim()) throw new Error("A source-grounded revision reason is required.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Revision must be a JSON object.");
  const edits = value as ProposalRevision;
  if (Object.keys(edits).some((key) => !["dropProposalIds", "removeEntityIds", "sanitizeTypes", "retypeEntities", "mentionedOnlyEntityIds"].includes(key))) throw new Error("Unsupported revision field.");
  for (const list of [edits.dropProposalIds, edits.removeEntityIds, edits.mentionedOnlyEntityIds]) {
    if (list !== undefined && (!Array.isArray(list) || list.length > 30 || list.some((item) => typeof item !== "string" || !item))) throw new Error("Revision id lists must contain at most 30 nonempty strings.");
  }
  if (edits.sanitizeTypes !== undefined && typeof edits.sanitizeTypes !== "boolean") throw new Error("sanitizeTypes must be boolean.");
  if (edits.retypeEntities !== undefined && (!Array.isArray(edits.retypeEntities) || edits.retypeEntities.length > 30 || edits.retypeEntities.some((entry) => !entry || typeof entry.entityId !== "string" || !entry.entityId || !["Character", "Location", "Organization", "Item", "Concept"].includes(entry.kind)))) throw new Error("Retyping requires at most 30 entity ids and supported entity kinds.");
  if (edits.retypeEntities?.length && !edits.sanitizeTypes) throw new Error("Retyping requires sanitizeTypes:true to normalize typed references atomically.");
  if (!edits.dropProposalIds?.length && !edits.removeEntityIds?.length && !edits.sanitizeTypes && !edits.retypeEntities?.length && !edits.mentionedOnlyEntityIds?.length) throw new Error("Revision contains no edits.");
  const changeset = await loadChangeSet(novelDir, id);
  if (!["held", "pending_review", "revision_requested"].includes(changeset.status)) throw new Error("Only unapproved review packets may be revised.");
  const history = await readFile(join(novelDir, "events.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  if (history.split("\n").filter(Boolean).map((line) => JSON.parse(line)).some((record) => record.event.type === "changeset.applied" && record.event.changesetId === id)) throw new Error("Applied packets require a canonical rollback plan, not proposal revision.");
  const drops = new Set(edits.dropProposalIds ?? []);
  const removed = new Set(edits.removeEntityIds ?? []);
  for (const proposalId of drops) if (!changeset.proposals.some((proposal) => proposal.id === proposalId)) throw new Error(`Unknown proposal ${proposalId}.`);
  const bundle = new BundleStore(join(novelDir, "ontology"));
  const canonical = new Map((await bundle.loadFile<Entity>("entities.jsonl")).map((entity) => [entity.id, entity]));
  for (const edit of edits.retypeEntities ?? []) {
    if (canonical.has(edit.entityId) || removed.has(edit.entityId)) throw new Error("Only retained, newly proposed entities may be retyped.");
    const proposal = changeset.proposals.find((proposal) => proposal.kind === "upsert_entity" && (proposal.payload as Entity).id === edit.entityId && !drops.has(proposal.id));
    if (!proposal) throw new Error(`Unknown retained proposed entity ${edit.entityId}.`);
    proposal.payload = { ...proposal.payload, kind: edit.kind };
  }
  for (const proposal of changeset.proposals) if (drops.has(proposal.id) && proposal.kind === "upsert_entity" && !canonical.has((proposal.payload as Entity).id)) removed.add((proposal.payload as Entity).id);
  for (const entityId of removed) {
    if (canonical.has(entityId)) throw new Error("Pending revision cannot remove an existing canonical entity.");
    if (!changeset.proposals.some((proposal) => proposal.kind === "upsert_entity" && (proposal.payload as Entity).id === entityId)) throw new Error(`Unknown proposed entity ${entityId}.`);
  }
  const removedEvents = new Set(changeset.proposals.filter((proposal) => drops.has(proposal.id) && proposal.kind === "create_event").map((proposal) => (proposal.payload as OntEvent).id));
  const removedScenes = new Set(changeset.proposals.filter((proposal) => drops.has(proposal.id) && proposal.kind === "create_scene").map((proposal) => (proposal.payload as Scene).id));
  const eventIds = new Set((await bundle.loadFile<OntEvent>("events.jsonl")).map((event) => event.id));
  const sceneIds = new Set((await bundle.loadFile<Scene>("scenes.jsonl")).map((scene) => scene.id));
  for (const proposal of changeset.proposals) if (!drops.has(proposal.id)) {
    if (proposal.kind === "create_event") eventIds.add((proposal.payload as OntEvent).id);
    if (proposal.kind === "create_scene") sceneIds.add((proposal.payload as Scene).id);
  }
  const entities = new Map(canonical);
  for (const proposal of changeset.proposals) if (proposal.kind === "upsert_entity" && !drops.has(proposal.id) && !removed.has((proposal.payload as Entity).id)) entities.set((proposal.payload as Entity).id, proposal.payload as Entity);
  const character = (entityId: string) => !removed.has(entityId) && (!edits.sanitizeTypes || entities.get(entityId)?.kind === "Character");
  const mentionedOnly = new Set(edits.mentionedOnlyEntityIds ?? []);
  for (const entityId of mentionedOnly) if (!character(entityId) || !entities.has(entityId)) throw new Error(`Mention-only identity ${entityId} must be a retained Character.`);
  let changed = 0;
  const original = changeset.proposals.length;
  changeset.proposals = changeset.proposals.filter((proposal) => {
    if (drops.has(proposal.id)) return false;
    if (proposal.kind === "upsert_entity" && removed.has((proposal.payload as Entity).id)) return false;
    if (proposal.kind === "add_relation") {
      const relation = proposal.payload as Relation;
      if ([relation.fromId, relation.toId].some((endpoint) => removed.has(endpoint) || removedEvents.has(endpoint) || removedScenes.has(endpoint))) return false;
      if (relation.type === "PARTICIPATES_IN" && mentionedOnly.has(relation.fromId)) return false;
      if (relation.type === "PRESENT_IN" && mentionedOnly.has(relation.fromId)) relation.type = "MENTIONED_IN";
      if (edits.sanitizeTypes) {
        if (["PARTICIPATES_IN", "STATE_BEFORE", "STATE_AFTER"].includes(relation.type) && (!character(relation.fromId) || !eventIds.has(relation.toId))) return false;
        if (["PRESENT_IN", "MENTIONED_IN"].includes(relation.type) && (!character(relation.fromId) || !sceneIds.has(relation.toId))) return false;
        if (["CAUSES", "CAUSED_BY", "PRECEDES"].includes(relation.type) && (!eventIds.has(relation.fromId) || !eventIds.has(relation.toId))) return false;
        if (relation.type === "LOCATED_AT" && (!sceneIds.has(relation.fromId) || entities.get(relation.toId)?.kind !== "Location")) return false;
        if (["KNOWS", "SPEAKS_TO", "ADDRESSES"].includes(relation.type) && (!character(relation.fromId) || !character(relation.toId))) return false;
      }
    }
    const before = JSON.stringify(proposal.payload);
    if (proposal.kind === "set_state_change") {
      const state = proposal.payload as { characterId: string; afterEventId: string; relationships?: Record<string, number> };
      if (!character(state.characterId) || removedEvents.has(state.afterEventId)) return false;
      if (state.relationships) state.relationships = Object.fromEntries(Object.entries(state.relationships).filter(([entityId]) => character(entityId)));
    }
    if (proposal.kind === "create_event") {
      const event = proposal.payload as OntEvent;
      event.primaryActors = event.primaryActors.filter((entityId) => character(entityId) && !mentionedOnly.has(entityId));
      event.affectedCharacters = event.affectedCharacters.filter((entityId) => character(entityId) && !mentionedOnly.has(entityId));
    }
    if (proposal.kind === "create_scene") {
      const scene = proposal.payload as Scene;
      const moved = scene.charactersPresent.filter((entityId) => character(entityId) && mentionedOnly.has(entityId));
      scene.charactersPresent = scene.charactersPresent.filter((entityId) => character(entityId) && !mentionedOnly.has(entityId));
      scene.charactersMentioned = [...new Set([...scene.charactersMentioned.filter(character), ...moved])];
      scene.turns = scene.turns.map((turn) => ({ ...turn, speakerId: turn.speakerId && character(turn.speakerId) && !mentionedOnly.has(turn.speakerId) ? turn.speakerId : null, addresseeId: turn.addresseeId && character(turn.addresseeId) && !mentionedOnly.has(turn.addresseeId) ? turn.addresseeId : null }));
      if (scene.locationId && (removed.has(scene.locationId) || edits.sanitizeTypes && entities.get(scene.locationId)?.kind !== "Location")) scene.locationId = null;
    }
    if (before !== JSON.stringify(proposal.payload)) changed++;
    return true;
  });
  const revisionId = randomUUID();
  const superseded = join(novelDir, "changesets", `${id}.superseded-revision-${revisionId}.json`);
  await copyFile(join(novelDir, "changesets", `${id}.json`), superseded);
  changeset.status = "held";
  changeset.reviewNotes[`revision:${revisionId}`] = `Reviewing agent revised pending proposals: ${reason}. Dropped ${original - changeset.proposals.length}; normalized ${changed} payloads. No new identities, presence, speakers or source facts were inferred. Re-read every proposal and note before approval.`;
  await saveChangeSet(novelDir, changeset);
  await appendAudit(novelDir, "revise-proposals", { changesetId: id, revisionId, edits, dropped: original - changeset.proposals.length, normalized: changed }, reason);
  return { id, status: changeset.status, revisionId, proposals: changeset.proposals.length, dropped: original - changeset.proposals.length, normalized: changed, supersededKept: true };
}
