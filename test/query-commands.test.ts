import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BundleStore } from "../src/connectors/bundle.js";
import { buildGraphFromBundle } from "../src/connectors/ladybug.js";
import {
  novelQuery,
  novelSearch,
  timelineList,
  timelineShow,
} from "../src/commands/queryCommands.js";
import type { Entity, OntEvent, Scene } from "../src/ontology/types.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

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

/** A novel workspace with a built graph; same fixture shape as graph.test.ts. */
async function fixtureNovel(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "novel-query-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const novelDir = join(root, "novel");
  const ontologyDir = join(novelDir, "ontology");
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
  await buildGraphFromBundle(ontologyDir, join(ontologyDir, "graph.lbug"));
  return novelDir;
}

function runCli(args: string[]) {
  // Fail any accidental model request, even without credentials.
  const noNetwork = "data:text/javascript," + encodeURIComponent(
    'globalThis.fetch = () => { throw new Error("Unexpected network request"); };',
  );
  const result = spawnSync(process.execPath, ["--import", noNetwork, cli, ...args], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, TYPESAFE_API_KEY: "", WORK_LLM_API_KEY: "" },
  });
  assert.ifError(result.error);
  return result;
}

test("query runs Cypher against the novel's built graph", async (t) => {
  const novelDir = await fixtureNovel(t);
  const all = await novelQuery(
    novelDir,
    "MATCH (c:Character) RETURN c.id AS id ORDER BY c.id",
  );
  assert.deepEqual(all.rows.map((r) => r.id), ["char_kuroko", "char_mikoto"]);

  const causes = await novelQuery(
    novelDir,
    "MATCH (a:Event)-[:CAUSES]->(b:Event) RETURN a.id AS from_id, b.id AS to_id",
  );
  assert.deepEqual(causes.rows, [{ from_id: "ev_001", to_id: "ev_002" }]);

  const none = await novelQuery(
    novelDir,
    "MATCH (c:Character) WHERE c.id = 'nobody' RETURN c.id AS id",
  );
  assert.deepEqual(none.rows, []);
});

test("search finds entities by name and events by summary text", async (t) => {
  const novelDir = await fixtureNovel(t);
  const bySummary = await novelSearch(novelDir, "café");
  assert.ok(bySummary.results.some((e) => e.id === "ev_001"));

  const byName = await novelSearch(novelDir, "白井黑子");
  assert.deepEqual(byName.results.map((e) => e.id), ["char_kuroko"]);

  const noHits = await novelSearch(novelDir, "zzz-no-such-thing");
  assert.deepEqual(noHits.results, []);
});

test("timeline list and show browse timelines and their time points", async (t) => {
  const novelDir = await fixtureNovel(t);
  const list = await timelineList(novelDir);
  assert.deepEqual(list.timelines, [
    { id: "tl_canon", label: "canon", eventCount: 2 },
  ]);

  // Default importance floor (forkPoints' 0.5): both fixture events qualify.
  const show = await timelineShow(novelDir, "tl_canon");
  assert.equal(show.timeline.label, "canon");
  assert.deepEqual(show.points.map((p) => p.id), ["ev_001", "ev_002"]);

  // A floor above every event's importance is a clean empty result.
  const none = await timelineShow(novelDir, "tl_canon", 0.9);
  assert.deepEqual(none.points, []);

  await assert.rejects(() => timelineShow(novelDir, "tl_nope"), /unknown timeline/);
  // An existing id that is not a timeline is unknown AS a timeline.
  await assert.rejects(() => timelineShow(novelDir, "char_mikoto"), /unknown timeline/);
});

test("empty bundle yields clean empty results, not errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-query-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const novelDir = join(root, "novel");
  const ontologyDir = join(novelDir, "ontology");
  const bundle = new BundleStore(ontologyDir);
  await bundle.init({
    novelId: "empty",
    title: "empty",
    schemaVersion: 1,
    sourceLanguages: [],
    embeddingModel: null,
    embeddingDimension: null,
    decisionModel: "jev-test",
    blocksProcessed: 0,
  });
  await buildGraphFromBundle(ontologyDir, join(ontologyDir, "graph.lbug"));

  assert.deepEqual((await novelSearch(novelDir, "anything")).results, []);
  assert.deepEqual((await timelineList(novelDir)).timelines, []);
  assert.deepEqual(
    (await novelQuery(novelDir, "MATCH (c:Character) RETURN c.id AS id")).rows,
    [],
  );
});

test("missing graph is a clear error, and nothing is created", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-query-nograph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const novelDir = join(root, "novel");
  const ontologyDir = join(novelDir, "ontology");
  const bundle = new BundleStore(ontologyDir);
  await bundle.init({
    novelId: "nograph",
    title: "nograph",
    schemaVersion: 1,
    sourceLanguages: [],
    embeddingModel: null,
    embeddingDimension: null,
    decisionModel: "jev-test",
    blocksProcessed: 0,
  });
  // Bundle exists but `novel graph build` never ran.
  await assert.rejects(
    () => novelSearch(novelDir, "x"),
    /graph store not found[\s\S]*novel graph build/,
  );
  await assert.rejects(
    () => novelQuery(join(root, "does-not-exist"), "MATCH (n) RETURN n"),
    /graph store not found/,
  );
});

test("stores close on success and on error (repeated + post-error calls work)", async (t) => {
  const novelDir = await fixtureNovel(t);
  for (let i = 0; i < 3; i++) {
    const hits = await novelSearch(novelDir, "café");
    assert.ok(hits.results.some((e) => e.id === "ev_001"));
  }
  // Error path: invalid Cypher throws, the store still closes (finally),
  // and the next command against the same database succeeds.
  await assert.rejects(() => novelQuery(novelDir, "MATCH (n RETURN n"));
  const after = await novelQuery(novelDir, "MATCH (c:Character) RETURN count(c) AS c");
  assert.equal(Number(after.rows[0].c), 2);
});

test("CLI: query/search/timeline happy paths print JSON", async (t) => {
  const novelDir = await fixtureNovel(t);

  const q = runCli(["query", novelDir, "MATCH (c:Character) RETURN c.id AS id ORDER BY c.id"]);
  assert.equal(q.status, 0, q.stderr);
  assert.deepEqual(
    JSON.parse(q.stdout).rows.map((r: { id: string }) => r.id),
    ["char_kuroko", "char_mikoto"],
  );

  const s = runCli(["search", novelDir, "café"]);
  assert.equal(s.status, 0, s.stderr);
  assert.ok(
    JSON.parse(s.stdout).results.some((e: { id: string }) => e.id === "ev_001"),
  );

  const tl = runCli(["timeline", "list", novelDir, "--pretty"]);
  assert.equal(tl.status, 0, tl.stderr);
  assert.ok(tl.stdout.includes("\n")); // pretty-printed
  assert.equal(JSON.parse(tl.stdout).timelines[0].id, "tl_canon");

  const ts = runCli(["timeline", "show", novelDir, "tl_canon"]);
  assert.equal(ts.status, 0, ts.stderr);
  assert.deepEqual(
    JSON.parse(ts.stdout).points.map((p: { id: string }) => p.id),
    ["ev_001", "ev_002"],
  );
});

test("CLI: invalid arguments and unknown ids are clear errors (exit 1)", async (t) => {
  const novelDir = await fixtureNovel(t);
  const cases: { args: string[]; error: RegExp }[] = [
    { args: ["query"], error: /Usage: novel query/ },
    { args: ["query", novelDir], error: /Usage: novel query/ },
    { args: ["search", novelDir], error: /Usage: novel search/ },
    { args: ["search", novelDir, "x", "--limit", "0"], error: /--limit must be a positive integer/ },
    { args: ["search", novelDir, "x", "--limit", "abc"], error: /--limit must be a positive integer/ },
    { args: ["timeline", "list"], error: /Usage: novel timeline/ },
    { args: ["timeline", "show", novelDir], error: /Usage: novel timeline show/ },
    {
      args: ["timeline", "show", novelDir, "tl_canon", "--min-importance", "2"],
      error: /--min-importance must be a number between 0 and 1/,
    },
    { args: ["timeline", "show", novelDir, "tl_nope"], error: /unknown timeline/ },
  ];
  for (const { args, error } of cases) {
    const result = runCli(args);
    assert.equal(result.status, 1, `${args.join(" ")} -> ${result.stdout}`);
    const parsed = JSON.parse(result.stderr) as { error: string };
    assert.match(parsed.error, error, args.join(" "));
  }
});
