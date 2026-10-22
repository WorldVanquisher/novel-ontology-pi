import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleStore } from "../src/connectors/bundle.js";
import { LadybugStore, buildGraphFromBundle } from "../src/connectors/ladybug.js";
import {
  causalAncestors,
  causalDescendants,
  charactersPresent,
  coPresentCharacters,
  sceneLocation,
} from "../src/ontology/retrieval.js";
import { newChangeSet } from "../src/merge/changeset.js";
import {
  listChangeSets,
  loadChangeSet,
  saveChangeSet,
  setChangeSetStatus,
} from "../src/merge/changesetStore.js";
import { applyChangeSet } from "../src/merge/apply.js";
import type { Entity, OntEvent, Scene } from "../src/ontology/types.js";

const char = (id: string, name: string): Entity => ({
  id,
  kind: "Character",
  names: [{ text: name, lang: "zh", kind: "canonical" }],
  properties: { importance: 0.9 },
  confidence: 0.95,
});

const ev = (id: string, order: number, summary: string, actors: string[]): OntEvent => ({
  id,
  timelineId: "tl_canon",
  chapterIndex: 1,
  chronologicalOrder: order,
  eventType: "dialogue",
  summaryEn: summary,
  evidence: { text: "…", sentenceIds: ["b0001_s001"] },
  importance: 0.8,
  primaryActors: actors,
  affectedCharacters: actors,
  confidence: 0.9,
});

test("closed stores release the database across repeated writes and reopens", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-reopen-"));
  const dbPath = join(root, "graph.lbug");
  // Retain old stores so database lifetime cannot depend on garbage collection.
  const stores: LadybugStore[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const writer = new LadybugStore(dbPath);
      stores.push(writer);
      await writer.upsertEntity(char(`char_${i}`, `角色 ${i}`));
      await writer.close();
      await writer.close();

      const reader = new LadybugStore(dbPath);
      stores.push(reader);
      for (let j = 0; j <= i; j++) {
        assert.equal((await reader.getEntity(`char_${j}`))?.names[0].text, `角色 ${j}`);
      }
      await reader.close();
    }
  } finally {
    for (const store of stores) await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("graph rebuild removes deleted bundle records and failed rebuild preserves the previous graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-rebuild-"));
  const ontologyDir = join(root, "ontology");
  const dbPath = join(ontologyDir, "graph.lbug");
  const bundle = new BundleStore(ontologyDir);
  try {
    await bundle.init({ novelId: "rebuild", title: "test", schemaVersion: 1, sourceLanguages: ["zh"], embeddingModel: null, embeddingDimension: null, decisionModel: "mock", blocksProcessed: 0 });
    await bundle.upsertEntity(char("char_keep", "保留"));
    await bundle.upsertEntity(char("char_drop", "删除"));
    await bundle.upsertEvent(ev("evt_drop", 1, "将被删除的事件", ["char_drop"]));
    await buildGraphFromBundle(ontologyDir, dbPath);
    await writeFile(join(ontologyDir, "entities.jsonl"), JSON.stringify(char("char_keep", "保留")) + "\n");
    await writeFile(join(ontologyDir, "events.jsonl"), "");
    await buildGraphFromBundle(ontologyDir, dbPath);
    const reader = new LadybugStore(dbPath);
    try {
      assert.equal(await reader.getEntity("char_drop"), null);
      assert.equal((await reader.getEntity("char_keep"))?.id, "char_keep");
      assert.deepEqual(await reader.run("MATCH (event:Event) RETURN event.id"), []);
    } finally { await reader.close(); }
    const original = await readFile(dbPath);
    await writeFile(join(ontologyDir, "entities.jsonl"), "{invalid JSON\n");
    await assert.rejects(buildGraphFromBundle(ontologyDir, dbPath));
    assert.deepEqual(await readFile(dbPath), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bundle -> ladybug build -> graph-only retrieval + changeset gate flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-test-"));
  const novelDir = join(root, "novel");
  const ontologyDir = join(novelDir, "ontology");
  try {
    const bundle = new BundleStore(ontologyDir);
    await bundle.init({
      novelId: "test",
      title: "test",
      schemaVersion: 1,
      sourceLanguages: ["zh"],
      embeddingModel: null,
      embeddingDimension: null,
      decisionModel: "jev-test",
      blocksProcessed: 0,
    });
    await bundle.upsertEntity(char("char_mikoto", "御坂美琴"));
    await bundle.upsertEntity(char("char_kuroko", "白井黑子"));
    await bundle.upsertEntity({
      id: "loc_cafe",
      kind: "Location",
      names: [{ text: "咖啡店", lang: "zh", kind: "canonical" }],
      properties: {},
      confidence: 1,
    });
    await bundle.upsertEntity({
      id: "tl_canon",
      kind: "Timeline",
      names: [{ text: "canon", lang: "en", kind: "canonical" }],
      properties: {},
      confidence: 1,
    });
    await bundle.upsertEvent(ev("ev_001", 1, "Kuroko waves Mikoto over in the café", ["char_kuroko"]));
    await bundle.upsertEvent(ev("ev_002", 2, "Mikoto agrees to meet again tomorrow", ["char_mikoto"]));
    const scene: Scene = {
      id: "sc_001",
      chapterIndex: 1,
      sentenceIds: ["b0001_s001"],
      charactersPresent: ["char_mikoto", "char_kuroko"],
      charactersMentioned: [],
      turns: [],
      locationId: "loc_cafe",
    };
    await bundle.upsertScene(scene);
    await bundle.addRelation({
      fromId: "ev_001", toId: "ev_002", type: "CAUSES",
      properties: {}, confidence: 0.8,
    });
    await bundle.addRelation({
      fromId: "char_kuroko", toId: "char_mikoto", type: "KNOWS",
      properties: { degree: 0.9 }, confidence: 1,
    });

    const dbPath = join(ontologyDir, "graph.lbug");
    const counts = await buildGraphFromBundle(ontologyDir, dbPath);
    assert.equal(counts.entities, 4);
    assert.equal(counts.events, 2);
    assert.equal(counts.scenes, 1);

    const store = new LadybugStore(dbPath);
    const mikoto = await store.getEntity("char_mikoto");
    assert.equal(mikoto?.names[0].text, "御坂美琴");
    const byName = await store.findByName("白井黑子");
    assert.deepEqual(byName.map((e) => e.id), ["char_kuroko"]);
    const events = await store.listEvents("tl_canon", 0.5);
    assert.deepEqual(events.map((e) => e.id), ["ev_001", "ev_002"]);
    const found = await store.searchText("café", 5);
    assert.ok(found.some((e) => e.id === "ev_001"));
    await assert.rejects(() => store.searchVector([0.1, 0.2], 5), /DEFERRED/);

    // The graph-first retrieval layer (the Phase 1 Cypher experiment):
    const present = await charactersPresent(store, "sc_001");
    assert.deepEqual(
      present.map((e) => e.id).sort(),
      ["char_kuroko", "char_mikoto"],
    );
    const co = await coPresentCharacters(store, "char_mikoto");
    assert.deepEqual(co.map((e) => e.id), ["char_kuroko"]);
    assert.deepEqual(await causalAncestors(store, "ev_002"), ["ev_001"]);
    assert.deepEqual(await causalDescendants(store, "ev_001"), ["ev_002"]);
    const loc = await sceneLocation(store, "sc_001");
    assert.equal(loc?.id, "loc_cafe");
    const knows = await store.traverse("char_kuroko", "KNOWS", 1);
    assert.deepEqual(knows.map((e) => e.id), ["char_mikoto"]);
    await store.close();

    // --- merge gate flow: changeset saved -> approved -> applied -> rebuilt
    const cs = newChangeSet("b0002");
    cs.status = "pending_review";
    cs.proposals.push({
      id: "p1",
      kind: "upsert_entity",
      payload: char("char_uiharu", "初春饰利"),
      confidence: 0.93,
      provenance: { blockId: "b0002", sentenceIds: ["b0002_s003"], patchId: "name-detector" },
    });
    await saveChangeSet(novelDir, cs);
    const listed = await listChangeSets(novelDir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, "pending_review");

    // Refused while not approved:
    const pending = await loadChangeSet(novelDir, cs.id);
    await assert.rejects(() => applyChangeSet(bundle, pending), /not approved/);

    const approved = await setChangeSetStatus(novelDir, cs.id, "approved");
    const { applied } = await applyChangeSet(bundle, approved);
    assert.equal(applied, 1);
    await buildGraphFromBundle(ontologyDir, dbPath);
    const store2 = new LadybugStore(dbPath);
    const uiharu = await store2.getEntity("char_uiharu");
    assert.equal(uiharu?.names[0].text, "初春饰利");
    await store2.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
