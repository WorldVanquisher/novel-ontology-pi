import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleStore } from "../src/connectors/bundle.js";
import { initWorkspace } from "../src/workspace/init.js";
import { newChangeSet } from "../src/merge/changeset.js";
import { saveChangeSet } from "../src/merge/changesetStore.js";
import { loadExtractionCounts } from "../src/processing/counts.js";

test("sequencing reserves approved identities and high-water marks after canonical deletion", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "novel-sequence-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "novel");
  await initWorkspace(directory);
  const changeset = newChangeSet("b0001");
  changeset.status = "approved";
  const provenance = { blockId: "b0001", sentenceIds: [], patchId: "test" };
  changeset.proposals = [
    { id: "entity", kind: "upsert_entity", payload: { id: "char_000099" }, confidence: 1, provenance },
    { id: "event", kind: "create_event", payload: { id: "evt_000009", chronologicalOrder: 12 }, confidence: 1, provenance },
    { id: "scene", kind: "create_scene", payload: { id: "scene_000005" }, confidence: 1, provenance },
  ];
  await saveChangeSet(directory, changeset);
  const pending = newChangeSet("b0002");
  pending.proposals = [{ id: "unapproved", kind: "create_event", payload: { id: "evt_999999" }, confidence: 1, provenance }];
  await saveChangeSet(directory, pending);
  const result = await loadExtractionCounts(directory, new BundleStore(join(directory, "ontology")));
  assert.deepEqual(result, { events: 12, scenes: 5, reservedEntityIds: ["char_000099"] });
});
