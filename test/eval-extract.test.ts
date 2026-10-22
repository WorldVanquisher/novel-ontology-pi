import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalExtract, evalRun } from "../src/commands/evalCommands.js";
import { initWorkspace } from "../src/workspace/init.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(args: string[]) {
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

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

const readJsonl = async (path: string): Promise<Record<string, unknown>[]> => {
  const raw = await readFile(path, "utf8");
  return raw.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
};

const ent = (id: string, kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, kind, names: [{ text: name, lang: "en", kind: "canonical" }], properties: {}, confidence: 1, ...extra,
});
const ev = (id: string, chapterIndex: number, summaryEn: string, actors: string[]) => ({
  id, timelineId: "tl_canon", chapterIndex, chronologicalOrder: chapterIndex,
  eventType: "action", summaryEn, evidence: { text: "", sentenceIds: [] },
  importance: 0.5, primaryActors: actors, affectedCharacters: actors, confidence: 1,
});
const rel = (fromId: string, type: string, toId: string) => ({ fromId, toId, type, properties: {}, confidence: 1 });

/**
 * A two-chapter bundle with known attribution:
 * - Alice is placed in ch1 (scene 1, events 1–2) and ch2 (scene 2, event 3).
 * - Bob and Dan only in ch2; Tower (scene 1 location) and Caro (scene 1
 *   mention + turn speaker, event 2 actor) only in ch1.
 * - The Guild entity is placed nowhere → unattributed.
 * - Relations: LOCATED_AT and PARTICIPATES_IN land in ch1, KNOWS in
 *   ch2; KNOWS→Guild has an unplaced endpoint and the PRECEDES spans
 *   both chapters → both unattributed.
 * - ev_x has no chapterIndex → unattributed.
 * - char_bob is written twice (append-only upsert): the last row wins.
 */
async function fixtureNovel(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "novel-eval-extract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const novelDir = join(root, "novel");
  await initWorkspace(novelDir);
  const ontology = join(novelDir, "ontology");

  await writeFile(join(ontology, "entities.jsonl"), jsonl([
    ent("char_alice", "Character", "Alice"),
    ent("char_bob", "Character", "Bob"),
    ent("char_dan", "Character", "Dan"),
    ent("loc_tower", "Location", "Tower"),
    ent("org_guild", "Organization", "Guild"),
    ent("char_caro", "Character", "Caro"),
    // Superseding upsert of char_bob (last write wins).
    { id: "char_bob", kind: "Character", names: [
      { text: "Bob", lang: "en", kind: "canonical" },
      { text: "Bobby", lang: "en", kind: "alias" },
    ], properties: {}, confidence: 0.9 },
  ]));
  await writeFile(join(ontology, "timelines.jsonl"), jsonl([
    ent("tl_canon", "Timeline", "Canon"),
  ]));
  await writeFile(join(ontology, "events.jsonl"), jsonl([
    ev("ev1", 1, "Alice enters the tower", ["char_alice"]),
    ev("ev2", 1, "Caro warns Alice", ["char_caro"]),
    ev("ev3", 2, "Bob leaves at dawn", ["char_bob", "char_alice"]),
    { id: "ev_x", timelineId: "tl_canon", summaryEn: "Untitled happening" },
  ]));
  await writeFile(join(ontology, "scenes.jsonl"), jsonl([
    { id: "sc1", chapterIndex: 1, sentenceIds: ["s1", "s2"], charactersPresent: ["char_alice"],
      charactersMentioned: ["char_caro"],
      turns: [{ speakerId: "char_caro", addresseeId: "char_alice", sentenceIds: ["s2"] }],
      locationId: "loc_tower" },
    { id: "sc2", chapterIndex: 2, sentenceIds: ["s3"], charactersPresent: ["char_alice", "char_bob", "char_dan"],
      charactersMentioned: [], turns: [], locationId: null },
  ]));
  await writeFile(join(ontology, "relations.jsonl"), jsonl([
    rel("char_alice", "LOCATED_AT", "loc_tower"),
    rel("char_alice", "PARTICIPATES_IN", "ev1"),
    rel("char_bob", "KNOWS", "char_alice"),
    rel("char_alice", "KNOWS", "org_guild"),
    rel("ev1", "PRECEDES", "ev3"),
  ]));
  return novelDir;
}

test("extract splits a bundle per chapter using stored fields only", async (t) => {
  const novelDir = await fixtureNovel(t);
  const predictions = join(novelDir, "..", "predictions");
  const r = await evalExtract(novelDir, predictions);

  assert.deepEqual(r.chapters, [
    { id: "ch01", chapterIndex: 1, entities: 3, relations: 2, events: 2 },
    { id: "ch02", chapterIndex: 2, entities: 3, relations: 1, events: 1 },
  ]);
  assert.deepEqual(r.written, { entities: 6, relations: 3, events: 3 });
  assert.deepEqual(r.unattributed, { entities: 1, relations: 2, events: 1 });

  const ch01Entities = await readJsonl(join(predictions, "ch01", "entities.jsonl"));
  assert.deepEqual(ch01Entities.map((e) => e.id), ["char_alice", "loc_tower", "char_caro"]);
  // Records are copied as stored — matcher fields verbatim.
  assert.deepEqual(ch01Entities[0].names, [{ text: "Alice", lang: "en", kind: "canonical" }]);

  const ch02Entities = await readJsonl(join(predictions, "ch02", "entities.jsonl"));
  assert.deepEqual(ch02Entities.map((e) => e.id), ["char_alice", "char_bob", "char_dan"]);
  // The superseding char_bob row won, exactly once.
  const bob = ch02Entities.filter((e) => e.id === "char_bob");
  assert.equal(bob.length, 1);
  assert.equal((bob[0].names as unknown[]).length, 2);

  const ch01Relations = await readJsonl(join(predictions, "ch01", "relations.jsonl"));
  assert.deepEqual(ch01Relations.map((x) => `${x.fromId}-${x.type}->${x.toId}`), [
    "char_alice-LOCATED_AT->loc_tower",
    "char_alice-PARTICIPATES_IN->ev1",
  ]);
  const ch02Relations = await readJsonl(join(predictions, "ch02", "relations.jsonl"));
  assert.deepEqual(ch02Relations.map((x) => `${x.fromId}-${x.type}->${x.toId}`), [
    "char_bob-KNOWS->char_alice",
  ]);
  const ch01Events = await readJsonl(join(predictions, "ch01", "events.jsonl"));
  assert.deepEqual(ch01Events.map((e) => e.id), ["ev1", "ev2"]);
  const ch02Events = await readJsonl(join(predictions, "ch02", "events.jsonl"));
  assert.deepEqual(ch02Events.map((e) => e.id), ["ev3"]);
});

test("extract of a fresh workspace writes an empty predictions dir, all zeroes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-eval-extract-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const novelDir = join(root, "novel");
  await initWorkspace(novelDir);
  const predictions = join(root, "predictions");
  const r = await evalExtract(novelDir, predictions);
  assert.deepEqual(r.chapters, []);
  assert.deepEqual(r.written, { entities: 0, relations: 0, events: 0 });
  assert.deepEqual(r.unattributed, { entities: 0, relations: 0, events: 0 });
  assert.deepEqual(await readdir(predictions), []); // dir exists, so eval run accepts it
});

test("extract tolerates records missing optional fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-eval-extract-sparse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const novelDir = join(root, "novel");
  await initWorkspace(novelDir);
  const ontology = join(novelDir, "ontology");
  // Entity with no names; scene with no turns/locationId fields at all;
  // event with no actor fields. Projection is by stored fields only —
  // nothing here may throw.
  await writeFile(join(ontology, "entities.jsonl"), jsonl([
    { id: "e1", kind: "Character", names: [], properties: {}, confidence: 1 },
  ]));
  await writeFile(join(ontology, "scenes.jsonl"), jsonl([
    { id: "s1", chapterIndex: 3, sentenceIds: [], charactersPresent: ["e1"], charactersMentioned: [] },
  ]));
  await writeFile(join(ontology, "events.jsonl"), jsonl([
    { id: "ev9", timelineId: "tl_canon", chapterIndex: 3, summaryEn: "Something happens" },
  ]));
  await writeFile(join(ontology, "relations.jsonl"), "");
  const predictions = join(root, "predictions");
  const r = await evalExtract(novelDir, predictions);
  assert.deepEqual(r.chapters, [{ id: "ch03", chapterIndex: 3, entities: 1, relations: 0, events: 1 }]);
  assert.deepEqual(r.unattributed, { entities: 0, relations: 0, events: 0 });
  const entities = await readJsonl(join(predictions, "ch03", "entities.jsonl"));
  assert.deepEqual(entities.map((e) => e.id), ["e1"]); // written as stored, names still empty
});

test("extract names the file and line for a corrupt bundle JSONL record", async (t) => {
  const novelDir = await fixtureNovel(t);
  await writeFile(join(novelDir, "ontology", "relations.jsonl"),
    JSON.stringify(rel("char_alice", "KNOWS", "char_bob")) + "\n{broken}\n");
  await assert.rejects(
    () => evalExtract(novelDir, join(novelDir, "..", "predictions")),
    /corrupt JSONL in relations\.jsonl line 2/,
  );
});

test("extract refuses a non-empty predictions dir (never overwrites)", async (t) => {
  const novelDir = await fixtureNovel(t);
  const predictions = join(novelDir, "..", "predictions");
  await mkdir(predictions, { recursive: true });
  await writeFile(join(predictions, "stale.txt"), "leftover\n");
  await assert.rejects(
    () => evalExtract(novelDir, predictions),
    /already exists and is not empty/,
  );
});

test("end to end: bundle → extract → eval run reproduces hand-computed scores", async (t) => {
  const novelDir = await fixtureNovel(t);
  const root = join(novelDir, "..");
  const predictions = join(root, "predictions");
  await evalExtract(novelDir, predictions);

  // Hand-written golden dataset over the same two chapters. Golden ids
  // differ from bundle ids, so all matches are semantic (pass 2).
  const dataset = join(root, "dataset");
  const golden = async (chapter: string, files: Record<string, unknown[]>) => {
    const dir = join(dataset, "golden", chapter);
    await mkdir(dir, { recursive: true });
    for (const kind of ["entities", "relations", "events"]) {
      await writeFile(join(dir, `${kind}.jsonl`), jsonl(files[kind] ?? []));
    }
  };
  await mkdir(dataset, { recursive: true });
  await writeFile(join(dataset, "dataset.json"), JSON.stringify({
    name: "extract e2e fixture",
    chapters: [
      { id: "ch01", golden: "golden/ch01" },
      { id: "ch02", golden: "golden/ch02" },
    ],
  }));
  await golden("ch01", {
    entities: [
      ent("g_alice", "Character", "Alice"),
      ent("g_tower", "Location", "Tower"),
      ent("g_caro", "Character", "Caro"),
      ent("g_guild", "Organization", "Guild"), // never predicted in ch01 → FN
    ],
    relations: [
      rel("g_alice", "LOCATED_AT", "g_tower"),
      rel("g_alice", "PARTICIPATES_IN", "g_ev1"),
      rel("g_caro", "SPEAKS_TO", "g_alice"), // turns are not relations → FN
    ],
    events: [
      ev("g_ev1", 1, "Alice enters the tower", ["g_alice"]),
      ev("g_ev2", 1, "Caro warns Alice", ["g_caro"]),
    ],
  });
  await golden("ch02", {
    entities: [ent("g_alice", "Character", "Alice"), ent("g_bob", "Character", "Bob")],
    relations: [rel("g_bob", "KNOWS", "g_alice")],
    events: [
      ev("g_ev3", 2, "Bob leaves at dawn", ["g_bob"]),
      ev("g_ev4", 2, "Alice sleeps", ["g_alice"]), // not in the bundle → FN
    ],
  });

  // Hand-computed from the fixture: entities TP5 (Alice×2, Tower, Caro,
  // Bob) FP1 (Dan) FN1 (Guild); relations TP3 FP0 FN1 (SPEAKS_TO);
  // events TP3 (ev1, ev2, ev3) FP0 FN1 (Alice sleeps). Dan is predicted
  // in ch02 but the golden set omits him → the one false positive.
  const r = await evalRun(dataset, predictions);
  assert.deepEqual(r.kinds.entities, { tp: 5, fp: 1, fn: 1, precision: 0.8333, recall: 0.8333, f1: 0.8333 });
  assert.deepEqual(r.kinds.relations, { tp: 3, fp: 0, fn: 1, precision: 1, recall: 0.75, f1: 0.8571 });
  assert.deepEqual(r.kinds.events, { tp: 3, fp: 0, fn: 1, precision: 1, recall: 0.75, f1: 0.8571 });
  assert.deepEqual(r.overall, { tp: 11, fp: 1, fn: 3, precision: 0.9167, recall: 0.7857, f1: 0.8462 });
  assert.deepEqual(r.spurious.map((s) => s.key), ["entity:Character:Dan"]);
});

test("CLI: eval extract prints JSON, --pretty works, usage errors exit 1", async (t) => {
  const novelDir = await fixtureNovel(t);
  const predictions = join(novelDir, "..", "predictions");
  const ok = runCli(["eval", "extract", novelDir, predictions]);
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout) as { chapters: unknown[] };
  assert.equal(parsed.chapters.length, 2);
  const pretty = runCli(["eval", "extract", novelDir, join(novelDir, "..", "predictions2"), "--pretty"]);
  assert.equal(pretty.status, 0, pretty.stderr);
  assert.ok(pretty.stdout.includes("\n  \"chapters\""));
  const usage = runCli(["eval", "extract", novelDir]);
  assert.equal(usage.status, 1);
  assert.match(JSON.parse(usage.stderr).error, /Usage: novel eval run/);
  const missing = runCli(["eval", "extract", join(novelDir, "nope"), join(novelDir, "..", "predictions3")]);
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stderr).error, /novel directory not found/);
});
