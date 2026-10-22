import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectNovel } from "../src/commands/inspectCommands.js";
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

/** A workspace with known contents, incl. one dangling relation endpoint. */
async function fixtureNovel(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "novel-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const novelDir = join(root, "novel");
  await initWorkspace(novelDir);
  const ontology = join(novelDir, "ontology");

  await writeFile(join(novelDir, "source", "novel.txt"),
    "Chapter 1 Start\n\nAlice enters.\n\nChapter 2 Middle\n\nBob leaves.\n");
  await writeFile(join(ontology, "entities.jsonl"), jsonl([
    { id: "char_a", kind: "Character", names: [{ text: "Alice", lang: "en", kind: "canonical" }], properties: {}, confidence: 1 },
    { id: "char_b", kind: "Character", names: [], properties: {}, confidence: 1 },
    { id: "loc_x", kind: "Location", names: [{ text: "Tower", lang: "en", kind: "canonical" }], properties: {}, confidence: 1 },
  ]));
  await writeFile(join(ontology, "timelines.jsonl"), jsonl([
    { id: "tl_canon", kind: "Timeline", names: [{ text: "Canon", lang: "en", kind: "canonical" }], properties: {}, confidence: 1 },
  ]));
  await writeFile(join(ontology, "events.jsonl"), jsonl([
    { id: "ev1", timelineId: "tl_canon", chapterIndex: 1, chronologicalOrder: 1, eventType: "action", summaryEn: "Alice enters", evidence: { text: "Alice enters.", sentenceIds: ["s1"] }, importance: 0.8, primaryActors: ["char_a"], affectedCharacters: ["char_a"], confidence: 1 },
    { id: "ev2", timelineId: "tl_ghost", chapterIndex: 2, chronologicalOrder: 2, eventType: "movement", summaryEn: "Bob leaves", evidence: { text: "", sentenceIds: [] }, importance: 0.5, primaryActors: ["char_missing"], affectedCharacters: [], confidence: 1 },
  ]));
  await writeFile(join(ontology, "scenes.jsonl"), jsonl([
    { id: "sc1", chapterIndex: 1, sentenceIds: ["s1"], charactersPresent: ["char_a"], charactersMentioned: ["char_ghost"], turns: [{ speakerId: "char_a", addresseeId: null, sentenceIds: ["s1"] }, { speakerId: null, addresseeId: null, sentenceIds: ["s2"] }], locationId: "loc_x" },
  ]));
  await writeFile(join(ontology, "relations.jsonl"), jsonl([
    { fromId: "char_a", toId: "loc_x", type: "LOCATED_AT", properties: {}, confidence: 1 },
    { fromId: "char_a", toId: "char_missing", type: "KNOWS", properties: {}, confidence: 1 },
  ]));
  await writeFile(join(ontology, "branches.jsonl"), jsonl([
    { id: "br1", parentTimelineId: "tl_canon", forkEventId: "ev1", label: "What if" },
  ]));
  await mkdir(join(novelDir, "branches", "br1"));
  await writeFile(join(novelDir, "branches", "br1", "delta.jsonl"), "");
  const cs = (id: string, status: string, proposals: number) => ({
    id, blockId: "b0001", status, reviewNotes: {}, createdAt: "2026-10-21T00:00:00Z",
    proposals: Array.from({ length: proposals }, (_, i) => ({ id: `${id}_p${i}` })),
  });
  await writeFile(join(novelDir, "changesets", "cs1.json"), JSON.stringify(cs("cs1", "pending_review", 2)));
  await writeFile(join(novelDir, "changesets", "cs2.json"), JSON.stringify(cs("cs2", "approved", 0)));
  return novelDir;
}

test("inspect reports exact counts, coverage and integrity tallies", async (t) => {
  const novelDir = await fixtureNovel(t);
  const r = await inspectNovel(novelDir);

  assert.equal(r.manifest.schemaVersion, 1);
  assert.equal(r.graph.built, false);
  assert.equal(r.source.totals.files, 1);
  assert.equal(r.source.totals.chapters, 2);
  assert.equal(r.source.totals.blocks, 2); // cutBlocks never merges across chapters
  assert.equal(r.source.files[0].name, "novel.txt");

  assert.deepEqual(r.ontology.entities, { total: 3, byKind: { Character: 2, Location: 1 } });
  assert.deepEqual(r.ontology.relations, { total: 2, byType: { KNOWS: 1, LOCATED_AT: 1 } });
  assert.equal(r.ontology.events.total, 2);
  assert.deepEqual(r.ontology.events.byTimeline, { tl_canon: 1, tl_ghost: 1 });
  assert.deepEqual(r.ontology.scenes, { total: 1, byChapter: { "1": 1 } });
  assert.equal(r.ontology.timelines.total, 1);
  assert.equal(r.ontology.branches.total, 1);

  assert.equal(r.coverage.entities.withNames, 2);
  assert.equal(r.coverage.entities.withoutNames, 1);
  assert.equal(r.coverage.entities.withCanonicalName, 2);
  assert.equal(r.coverage.events.withTimelineId, 2);
  assert.equal(r.coverage.events.referencingUnknownTimeline, 1);
  assert.equal(r.coverage.events.withEvidence, 1);
  assert.equal(r.coverage.events.withoutEvidence, 1);
  assert.equal(r.coverage.events.evidenceRatio, 0.5);
  assert.equal(r.coverage.events.withPrimaryActors, 2);
  assert.equal(r.coverage.scenes.dialogueTurns, 2);
  assert.equal(r.coverage.scenes.unresolvedTurns, 1);

  assert.equal(r.integrity.relations.fullyResolved, 1);
  assert.equal(r.integrity.relations.danglingFromRefs, 0);
  assert.equal(r.integrity.relations.danglingToRefs, 1);
  assert.equal(r.integrity.events.unknownPrimaryActorRefs, 1);
  assert.equal(r.integrity.events.unknownTimelineRefs, 1);
  assert.equal(r.integrity.scenes.unknownCharacterRefs, 1);
  assert.equal(r.integrity.scenes.unknownLocationRefs, 0);
  assert.equal(r.integrity.branches.unknownParentTimelineRefs, 0);
  assert.equal(r.integrity.branches.unknownForkEventRefs, 0);

  assert.deepEqual(r.branches.dirs, [{ id: "br1", files: ["delta.jsonl"] }]);
  assert.deepEqual(r.changesets, {
    total: 2,
    byStatus: { approved: 1, pending_review: 1 },
    proposalsTotal: 2,
  });
});

test("inspect of a fresh workspace is clean zeroes, not an error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-inspect-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const novelDir = join(root, "novel");
  await initWorkspace(novelDir);
  const r = await inspectNovel(novelDir);
  assert.equal(r.ontology.entities.total, 0);
  assert.equal(r.ontology.events.total, 0);
  assert.equal(r.coverage.events.evidenceRatio, null);
  assert.equal(r.source.totals.files, 0);
  assert.equal(r.changesets.total, 0);
  assert.deepEqual(r.branches.dirs, []);
});

test("inspect names the file and line for a corrupt JSONL record", async (t) => {
  const novelDir = await fixtureNovel(t);
  await writeFile(join(novelDir, "ontology", "events.jsonl"),
    JSON.stringify({ id: "ev1" }) + "\n{not json}\n");
  await assert.rejects(
    () => inspectNovel(novelDir),
    /corrupt JSONL in bundle: ontology\/events\.jsonl line 2/,
  );
});

test("CLI: inspect prints JSON (and --pretty), missing dir is exit 1", async (t) => {
  const novelDir = await fixtureNovel(t);
  const ok = runCli(["inspect", novelDir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ontology.entities.total, 3);
  const pretty = runCli(["inspect", novelDir, "--pretty"]);
  assert.equal(pretty.status, 0, pretty.stderr);
  assert.ok(pretty.stdout.includes("\n  \"manifest\""));
  const missing = runCli(["inspect", join(novelDir, "nope")]);
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stderr).error, /novel directory not found/);
  const usage = runCli(["inspect"]);
  assert.equal(usage.status, 1);
  assert.match(JSON.parse(usage.stderr).error, /Usage: novel inspect/);
});
