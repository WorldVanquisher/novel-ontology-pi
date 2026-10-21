import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleStore } from "../src/connectors/bundle.js";
import {
  exportBundle,
  importBundle,
} from "../src/connectors/bundleTransfer.js";
import {
  LadybugStore,
  buildGraphFromBundle,
} from "../src/connectors/ladybug.js";
import {
  causalAncestors,
  charactersPresent,
} from "../src/ontology/retrieval.js";
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

/** A novel dir with source, ontology, branch deltas, a changeset — plus a
 *  derived graph file and a secret file that must never travel. */
async function buildFixtureNovel(novelDir: string): Promise<void> {
  const ontologyDir = join(novelDir, "ontology");
  const bundle = new BundleStore(ontologyDir);
  await bundle.init({
    novelId: "fixture",
    title: "Fixture Novel",
    schemaVersion: 1,
    sourceLanguages: ["zh"],
    embeddingModel: null,
    embeddingDimension: null,
    decisionModel: "jev-test",
    blocksProcessed: 3,
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
  // A record carrying a field this version does not know about — the
  // round-trip must preserve it byte-for-byte.
  await appendFile(
    join(ontologyDir, "entities.jsonl"),
    JSON.stringify({
      ...char("char_future", "未来角色"),
      futureField: { nested: [1, 2, 3], note: "added by a newer version" },
    }) + "\n",
  );
  await writeFile(
    join(ontologyDir, "timelines.jsonl"),
    JSON.stringify({
      id: "tl_canon",
      kind: "Timeline",
      names: [{ text: "canon", lang: "en", kind: "canonical" }],
      properties: {},
      confidence: 1,
    }) + "\n",
  );
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
  await bundle.createBranch({
    id: "br_001",
    parentTimelineId: "tl_canon",
    forkEventId: "ev_002",
    label: "what-if",
  });

  await mkdir(join(novelDir, "source"), { recursive: true });
  await writeFile(join(novelDir, "source", "novel.txt"), "第一章 咖啡店。\n");
  const branchDir = join(novelDir, "branches", "br_001");
  await mkdir(branchDir, { recursive: true });
  await writeFile(
    join(branchDir, "delta-events.jsonl"),
    JSON.stringify(ev("ev_b001", 3, "Branch-only event", ["char_mikoto"])) + "\n",
  );
  await writeFile(
    join(branchDir, "state-snapshot.json"),
    JSON.stringify({ atEventId: "ev_002", states: {} }, null, 2),
  );
  await mkdir(join(novelDir, "changesets"), { recursive: true });
  await writeFile(
    join(novelDir, "changesets", "cs_001.json"),
    JSON.stringify({ id: "cs_001", status: "approved", proposals: [] }, null, 2),
  );

  // Derived + secret material that must be excluded from any transfer:
  await writeFile(join(ontologyDir, "graph.lbug"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(novelDir, ".env"), "WORK_LLM_API_KEY=<redacted>\n");
}

async function listFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(root, full)));
    else if (e.isFile()) out.push(full.slice(root.length + 1));
  }
  return out.sort();
}

async function assertTreesByteEqual(a: string, b: string): Promise<void> {
  const filesA = await listFiles(a);
  const filesB = await listFiles(b);
  assert.deepEqual(filesB, filesA);
  for (const rel of filesA) {
    const [ba, bb] = await Promise.all([
      readFile(join(a, rel)),
      readFile(join(b, rel)),
    ]);
    assert.ok(ba.equals(bb), `file bytes differ: ${rel}`);
  }
}

test("bundle export -> import round-trip is byte-faithful and rebuilds a queryable graph", async () => {
  const root = await mkdtempSafe();
  const novelDir = join(root, "novel");
  const exportDir = join(root, "exported");
  const targetDir = join(root, "imported");
  try {
    await buildFixtureNovel(novelDir);

    const exp = await exportBundle(novelDir, exportDir);
    assert.equal(exp.novelId, "fixture");
    assert.equal(exp.recordCounts.entities, 4);
    assert.equal(exp.recordCounts.events, 2);
    assert.equal(exp.recordCounts.branches, 1);
    const excludedPaths = exp.excluded.map((e) => e.path).sort();
    assert.deepEqual(excludedPaths, [".env", "ontology/graph.lbug"]);
    // Excluded material is really absent from the export:
    await assert.rejects(() => stat(join(exportDir, ".env")));
    await assert.rejects(() => stat(join(exportDir, "ontology", "graph.lbug")));

    const imp = await importBundle(exportDir, targetDir);
    assert.equal(imp.novelId, "fixture");
    assert.equal(imp.fileCount, exp.fileCount);

    // Deep fidelity: every exported file arrives byte-identical.
    await assertTreesByteEqual(exportDir, targetDir);

    // The unrecognized field survived, parsed back exactly:
    const entityLines = (await readFile(join(targetDir, "ontology", "entities.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const future = entityLines.find((e) => e.id === "char_future");
    assert.deepEqual(future?.futureField, {
      nested: [1, 2, 3],
      note: "added by a newer version",
    });

    // The imported bundle rebuilds a Ladybug graph that answers queries:
    const ontologyDir = join(targetDir, "ontology");
    const dbPath = join(ontologyDir, "graph.lbug");
    const counts = await buildGraphFromBundle(ontologyDir, dbPath);
    assert.equal(counts.events, 2);
    assert.equal(counts.branches, 1);
    const store = new LadybugStore(dbPath);
    const present = await charactersPresent(store, "sc_001");
    assert.deepEqual(
      present.map((e) => e.id).sort(),
      ["char_kuroko", "char_mikoto"],
    );
    assert.deepEqual(await causalAncestors(store, "ev_002"), ["ev_001"]);
    const mikoto = await store.getEntity("char_mikoto");
    assert.equal(mikoto?.names[0].text, "御坂美琴");
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import refuses an existing target and leaves it untouched", async () => {
  const root = await mkdtempSafe();
  const novelDir = join(root, "novel");
  const exportDir = join(root, "exported");
  const targetDir = join(root, "taken");
  try {
    await buildFixtureNovel(novelDir);
    await exportBundle(novelDir, exportDir);
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "sentinel.txt"), "do not touch");
    await assert.rejects(
      () => importBundle(exportDir, targetDir),
      /already exists.*refusing to overwrite/,
    );
    assert.equal(await readFile(join(targetDir, "sentinel.txt"), "utf8"), "do not touch");
    // Export has the same no-overwrite rule:
    await assert.rejects(
      () => exportBundle(novelDir, exportDir),
      /already exists.*refusing to overwrite/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import rejects an invalid manifest before writing anything", async () => {
  const root = await mkdtempSafe();
  const badDir = join(root, "bad");
  const targetDir = join(root, "imported");
  try {
    await mkdir(join(badDir, "ontology"), { recursive: true });
    await writeFile(
      join(badDir, "ontology", "manifest.json"),
      JSON.stringify({
        novelId: "x",
        title: "Bad",
        schemaVersion: 99,
        sourceLanguages: ["en"],
        decisionModel: "jev-test",
      }),
    );
    await assert.rejects(
      () => importBundle(badDir, targetDir),
      /invalid bundle manifest.*schemaVersion/,
    );
    await assert.rejects(() => stat(targetDir)); // no target was created
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import rejects corrupt JSONL naming file and line, leaving no partial target", async () => {
  const root = await mkdtempSafe();
  const novelDir = join(root, "novel");
  const exportDir = join(root, "exported");
  const targetDir = join(root, "imported");
  try {
    await buildFixtureNovel(novelDir);
    await exportBundle(novelDir, exportDir);
    // Corrupt line 2 of events.jsonl inside the exported bundle:
    const eventsPath = join(exportDir, "ontology", "events.jsonl");
    const lines = (await readFile(eventsPath, "utf8")).split("\n");
    lines[1] = "{not json";
    await writeFile(eventsPath, lines.join("\n"));

    await assert.rejects(
      () => importBundle(exportDir, targetDir),
      /corrupt JSONL in bundle: ontology\/events\.jsonl line 2/,
    );
    await assert.rejects(() => stat(targetDir)); // nothing half-written
    const siblings = await readdir(root);
    assert.ok(
      !siblings.some((s) => s.includes(".staging-")),
      "no staging directory left behind",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function mkdtempSafe(): Promise<string> {
  return mkdtemp(join(tmpdir(), "novel-bundle-test-"));
}
