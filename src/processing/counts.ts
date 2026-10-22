import type { BundleStore } from "../connectors/bundle.js";
import { listChangeSets } from "../merge/changesetStore.js";

interface SequencedRecord {
  id: string;
  chronologicalOrder?: number;
}

export async function loadExtractionCounts(novelDir: string, bundle: BundleStore) {
  const history = (await listChangeSets(novelDir)).filter((changeset) => changeset.status === "approved");
  const previous = (kind: string) => history.flatMap((changeset) => changeset.proposals
    .filter((proposal) => proposal.kind === kind)
    .map((proposal) => proposal.payload as SequencedRecord));
  const events = [...await bundle.loadFile<SequencedRecord>("events.jsonl"), ...previous("create_event")];
  const scenes = [...await bundle.loadFile<SequencedRecord>("scenes.jsonl"), ...previous("create_scene")];
  const sequence = (records: SequencedRecord[]) => Math.max(0, new Set(records.map((record) => record.id)).size,
    ...records.map((record) => Number(record.id.match(/_(\d+)$/)?.[1] ?? 0)),
    ...records.map((record) => record.chronologicalOrder ?? 0));
  return { events: sequence(events), scenes: sequence(scenes), reservedEntityIds: previous("upsert_entity").map((entity) => entity.id).filter(Boolean) };
}
