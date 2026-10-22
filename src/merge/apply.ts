import type { OntologyStore } from "../ontology/store.js";
import type { ChangeSet } from "./changeset.js";
import type { Entity, OntEvent, Relation, Scene } from "../ontology/types.js";
import type { EventSink } from "../events/types.js";

/**
 * Applies an APPROVED ChangeSet to the ontology main graph.
 * This is the only code path from miniloop output to the store, and it is
 * only reachable after the main agent approves the merge (DESIGN.md
 * §Merge gate). Held or revision-requested change sets never reach here.
 */
export async function applyChangeSet(
  store: OntologyStore,
  changeset: ChangeSet,
  emit?: EventSink,
): Promise<{ applied: number; processed: number; deferred: number }> {
  if (changeset.status !== "approved") {
    throw new Error(
      `Refusing to apply change set ${changeset.id}: status is ${changeset.status}, not approved.`,
    );
  }
  let applied = 0;
  for (const p of changeset.proposals) {
    switch (p.kind) {
      case "upsert_entity":
        await store.upsertEntity(p.payload as Entity);
        break;
      case "create_event":
        await store.upsertEvent(p.payload as OntEvent);
        break;
      case "create_scene":
        await store.upsertScene(p.payload as Scene);
        break;
      case "add_relation":
        await store.addRelation(p.payload as Relation);
        break;
      case "add_alias":
      case "set_state_change":
        // Alias/state payloads are folded into entity/event updates by the
        // extraction step before apply time (see DESIGN.md open questions).
        break;
    }
    applied++;
  }
  const unsupportedProposalIds = changeset.proposals
      .filter((p) => p.kind === "add_alias" || p.kind === "set_state_change")
      .map((p) => p.id);
  if (emit) {
    await emit({ type: "changeset.applied", changesetId: changeset.id, target: "store", processed: applied, unsupportedProposalIds });
    // These two proposal kinds are still no-ops in the existing apply path.
    // Do not describe a partially materialized ChangeSet as merged.
    if (!unsupportedProposalIds.length) await emit({ type: "changeset.merged", changesetId: changeset.id, target: "store" });
  }
  return { applied: applied - unsupportedProposalIds.length, processed: applied, deferred: unsupportedProposalIds.length };
}
