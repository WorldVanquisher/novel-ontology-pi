import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkMatches,
  foldVariants,
  nominateMatchCandidates,
} from "../src/matching/entityMatch.js";
import { MockDecisionModel } from "../src/connectors/jev.js";
import { Miniloop } from "../src/autostep/miniloop.js";
import { sectionBlock } from "../src/text/sectioning.js";
import { initWorkspace } from "../src/workspace/init.js";
import { BundleStore } from "../src/connectors/bundle.js";
import {
  addNameForm,
  mergeEntities,
  relate,
  removeEntity,
  renameEntity,
  unrelate,
} from "../src/maintenance/fixes.js";
import { runFix } from "../src/commands/fixCommands.js";
import {
  addCorrection,
  loadCorrections,
  pinsForBlock,
} from "../src/maintenance/corrections.js";
import { ingestNovel } from "../src/commands/ingestCommands.js";
import { runRecall } from "../src/commands/recallCommands.js";
import type { Entity, OntEvent, Relation, Scene } from "../src/ontology/types.js";

const ent = (id: string, kind: Entity["kind"], ...forms: string[]): Entity => ({
  id,
  kind,
  names: forms.map((text, i) => ({ text, lang: "zh", kind: i === 0 ? "canonical" : "alias" })),
  properties: {},
  confidence: 1,
});

test("matching nomination: variant fold, containment, and near-identical forms; kind-gated", () => {
  assert.equal(foldVariants("白井黒子"), "白井黑子");
  const entities = [
    ent("char_000001", "Character", "白井黒子"),
    ent("char_000002", "Character", "白井黑子"),
    ent("char_000003", "Character", "食蜂操祈"),
    ent("char_000004", "Character", "食蜂"),
    ent("loc_000001", "Location", "第七学区车站前的繁华街"),
    ent("loc_000002", "Location", "学园都市第七学区车站前的繁华街"),
    ent("char_000005", "Character", "上条当麻"),
  ];
  const pairs = nominateMatchCandidates(entities);
  const has = (a: string, b: string) =>
    pairs.some((p) => [p.aId, p.bId].sort().join() === [a, b].sort().join());
  assert.ok(has("char_000001", "char_000002"), "kanji-variant pair nominated");
  assert.ok(
    pairs.find((p) => p.aId === "char_000001")?.reasons.some((r) => /script-variant/.test(r)),
  );
  assert.ok(has("char_000003", "char_000004"), "containment pair nominated");
  assert.ok(has("loc_000001", "loc_000002"), "location containment nominated");
  assert.ok(!has("char_000005", "char_000001"), "unrelated pair not nominated");
  assert.ok(!pairs.some((p) => p.aId.startsWith("loc") && p.bId.startsWith("char")), "kind-gated");
});

test("matching checklist routes: confident settles, uncertain escalates, distinct settles apart", async () => {
  const entities = [
    ent("char_000001", "Character", "甲"),
    ent("char_000002", "Character", "甲子"),
    ent("char_000003", "Character", "乙"),
    ent("char_000004", "Character", "乙子"),
    ent("char_000005", "Character", "丙"),
    ent("char_000006", "Character", "丙子"),
    ent("char_000007", "Character", "丁"),
    ent("char_000008", "Character", "丁子"),
  ];
  const cand = (i: number) => ({
    aId: entities[i * 2].id,
    bId: entities[i * 2 + 1].id,
    kind: "Character",
    aForms: ["x"],
    bForms: ["y"],
    reasons: ["test"],
    codeScore: 0.8,
  });
  const mock = new MockDecisionModel({
    "same:0": 0.95, "distinct:0": 0.05, "variant:0": 0.9, // confident
    "same:1": 0.6, "distinct:1": 0.2, "variant:1": 0.5, // uncertain -> agent
    "same:2": 0.9, "distinct:2": 0.92, "variant:2": 0.1, // distinct wins
    "same:3": 0.2, "distinct:3": 0.1, "variant:3": 0.1, // rejected
  });
  const verdicts = await checkMatches(mock, [cand(0), cand(1), cand(2), cand(3)], entities, []);
  assert.deepEqual(
    verdicts.map((v) => v.verdict),
    ["confident", "uncertain", "distinct", "rejected"],
  );
  assert.equal(verdicts[0].keepId, "char_000001");
});

async function makeWorkspace() {
  // initWorkspace creates the directory itself and refuses existing ones.
  const parent = await mkdtemp(join(tmpdir(), "novel-fix-"));
  const dir = join(parent, "novel");
  await initWorkspace(dir);
  return dir;
}

test("fix merge folds names, rewires relations/events/scenes, and leaves an audit entry", async () => {
  const dir = await makeWorkspace();
  const store = new BundleStore(join(dir, "ontology"));
  const keep = ent("char_000001", "Character", "白井黑子");
  const drop = ent("char_000002", "Character", "白井黒子", "黒子");
  const other = ent("char_000003", "Character", "御坂美琴");
  await store.upsertEntity(keep);
  await store.upsertEntity(drop);
  await store.upsertEntity(other);
  const ev: OntEvent = {
    id: "evt_000001", timelineId: "tl_canon", chapterIndex: 0, chronologicalOrder: 1,
    eventType: "action", summaryEn: "Kuroko teleports in", evidence: { text: "", sentenceIds: [] },
    importance: 0.5, primaryActors: ["char_000002"], affectedCharacters: ["char_000002", "char_000003"], confidence: 1,
  };
  await store.upsertEvent(ev);
  const rel: Relation = { fromId: "char_000003", toId: "char_000002", type: "KNOWS", properties: {}, confidence: 1 };
  const selfAfter: Relation = { fromId: "char_000001", toId: "char_000002", type: "KNOWS", properties: {}, confidence: 1 };
  await store.addRelation(rel);
  await store.addRelation(selfAfter);
  const scene: Scene = {
    id: "scene_000001", chapterIndex: 0, sentenceIds: [], charactersPresent: ["char_000002"],
    charactersMentioned: [], turns: [{ speakerId: "char_000002", addresseeId: "char_000003", sentenceIds: [] }],
    locationId: null,
  };
  await store.upsertScene(scene);

  const out = await mergeEntities(dir, "char_000001", "char_000002", "same person, kanji variant");
  assert.deepEqual(out.rewired, { relations: 2, events: 1, scenes: 1 });

  const entities = await store.loadFile<Entity>("entities.jsonl");
  const folded = new Map<string, Entity>();
  for (const e of entities) folded.set(e.id, e);
  assert.ok(!folded.has("char_000002"), "drop entity gone");
  assert.deepEqual(
    folded.get("char_000001")!.names.map((n) => n.text),
    ["白井黑子", "白井黒子", "黒子"],
    "names folded, none lost",
  );
  const rels = await store.loadFile<Relation>("relations.jsonl");
  assert.deepEqual(
    rels.map((r) => `${r.fromId}->${r.toId}`),
    ["char_000003->char_000001"],
    "relation rewired; merge-created self-loop dropped",
  );
  const events = await store.loadFile<OntEvent>("events.jsonl");
  assert.deepEqual(events[0].primaryActors, ["char_000001"]);
  assert.deepEqual(events[0].affectedCharacters, ["char_000001", "char_000003"]);
  const scenes = await store.loadFile<Scene>("scenes.jsonl");
  assert.equal(scenes[0].turns[0].speakerId, "char_000001");

  const audit = await readFile(join(dir, "maintenance.jsonl"), "utf8");
  assert.match(audit, /"op":"merge"/);
  assert.match(audit, /kanji variant/);
});

test("fix rename keeps the old canonical as an alias; add-form, relate/unrelate, remove work", async () => {
  const dir = await makeWorkspace();
  const store = new BundleStore(join(dir, "ontology"));
  await store.upsertEntity(ent("char_000001", "Character", "食蜂"));
  await store.upsertEntity(ent("char_000002", "Character", "御坂美琴"));

  const renamed = await renameEntity(dir, "char_000001", "食蜂操祈");
  assert.deepEqual(renamed.names.map((n) => n.text), ["食蜂操祈", "食蜂"]);
  const formed = await addNameForm(dir, "char_000001", "女王", "nickname");
  assert.ok(formed.names.some((n) => n.text === "女王" && n.kind === "nickname"));

  assert.deepEqual(await relate(dir, "char_000001", "char_000002", "KNOWS"), { added: true });
  assert.deepEqual(await relate(dir, "char_000001", "char_000002", "KNOWS"), { added: false });
  assert.deepEqual(await unrelate(dir, "char_000001", "char_000002", "KNOWS"), { removed: 1 });

  const removed = await removeEntity(dir, "char_000002");
  assert.equal(removed.removed, "char_000002");
  const entities = await store.loadFile<Entity>("entities.jsonl");
  assert.ok(!entities.some((e) => e.id === "char_000002"));
});

test("runFix rebuilds the graph after a merge", async () => {
  const dir = await makeWorkspace();
  const store = new BundleStore(join(dir, "ontology"));
  await store.upsertEntity(ent("char_000001", "Character", "甲"));
  await store.upsertEntity(ent("char_000002", "Character", "甲子"));
  const res = await runFix(dir, "merge", ["char_000001", "char_000002"], { reason: "test" });
  assert.equal(res.graph?.entities, 1);
});

test("corrections: pin, re-pin replaces, pins map per block", async () => {
  const dir = await makeWorkspace();
  await addCorrection(dir, { blockId: "b0001", key: "boundary:s0005", value: 1, reason: "scene clearly changes" });
  await addCorrection(dir, { blockId: "b0001", key: "boundary:s0005", value: 0, reason: "re-diagnosed: same scene" });
  await addCorrection(dir, { blockId: "b0002", key: "speaker:0", value: "char_000001", reason: "" });
  const all = await loadCorrections(dir);
  assert.equal(all.length, 2, "re-pin replaced the earlier correction");
  const pins = pinsForBlock(all, "b0001");
  assert.equal(pins.get("boundary:s0005"), 0);
  assert.equal(pinsForBlock(all, "b0002").get("speaker:0"), "char_000001");
});

test("miniloop honors a pinned boundary against the model's own answer", async () => {
  const { sentences } = sectionBlock("第一句。第二句。第三句。", 0);
  const ids = sentences.map((s) => s.id);
  const mock = new MockDecisionModel({}); // every boundary -> 0 (no split)
  const loop = new Miniloop(mock, {});
  const plain = await loop.runBlock({
    blockId: "b0001", sentences, knownEntities: [], stateSummary: "t",
  });
  assert.equal((plain.accepted["sceneSpans"] as string[][]).length, 1);
  const pinned = await loop.runBlock({
    blockId: "b0001",
    sentences,
    knownEntities: [],
    stateSummary: "t",
    pinnedAnswers: new Map([[`boundary:${ids[1]}`, 1]]),
  });
  assert.equal((pinned.accepted["sceneSpans"] as string[][]).length, 2, "pin forced the split");
  assert.deepEqual(pinned.appliedPins, [`boundary:${ids[1]}`]);
});

/** Minimal loopback Jev mock (same wire answers as the ingest suite). */
async function startMockJev(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as {
        state: string;
        questions: Record<string, { type: string; instructions?: string }>;
      };
      const answers: Record<string, unknown> = {};
      for (const [key, q] of Object.entries(parsed.questions)) {
        const ins = q.instructions ?? "";
        if (q.type === "noul") {
          let v = 0.1;
          if (ins.includes("contain any spoken dialogue")) v = /「|"|『/.test(parsed.state) ? 0.9 : 0.1;
          else if (ins.includes("known character") && ins.includes("physically present")) v = 0.95;
          else if (ins.includes("new scene")) v = 0.1;
          else if (ins.includes("continue the same spoken dialogue")) v = 0.1;
          answers[key] = { type: "noul", noul: v };
        } else if (q.type === "choice") {
          let v = "description";
          if (ins.includes("What kind of segment")) v = "narration";
          else if (ins.includes("Who is speaking")) v = "narrator";
          else if (ins.includes("nickname, epithet or title")) v = "none";
          answers[key] = { type: "choice", choice: v, distribution: { [v]: 0.9 }, confidence: 0.9 };
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock jev: no address");
  return {
    url: `http://127.0.0.1:${addr.port}/v1/systemone`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test("recall: a held block re-runs with the pin honored and the old changeset kept", async () => {
  const jev = await startMockJev();
  try {
    const dir = await makeWorkspace();
    const file = join(dir, "novel.txt");
    await writeFile(
      file,
      [
        "第一章 开始",
        "御坂美琴走进教室，坐了下来。她翻开课本，开始预习今天的内容。窗外的阳光洒在课桌上。",
        "放学后，御坂美琴独自走在回宿舍的路上。她小声说道：「今天真是漫长的一天。」",
      ].join("\n"),
      "utf8",
    );
    const store = new BundleStore(join(dir, "ontology"));
    await store.upsertEntity(ent("char_000001", "Character", "御坂美琴"));
    const env = {
      ...process.env,
      TYPESAFE_API_KEY: ["sk", "test", "fake", "key"].join("-"),
      JEV_ENDPOINT: jev.url,
      NOVEL_SECRETS_DIR: join(dir, "secrets"),
    };
    const first = await ingestNovel(dir, file, { env, maxBlocks: 1 });
    assert.equal(first.stoppedAt, "b0001", "gate mode holds the first block");

    // The reviewer traces the problem to one boundary decision and pins it.
    const { sentences } = sectionBlock(
      "御坂美琴走进教室，坐了下来。她翻开课本，开始预习今天的内容。窗外的阳光洒在课桌上。",
      0,
    );
    const pinKey = `boundary:${sentences[1].id}`;
    await addCorrection(dir, { blockId: "b0001", key: pinKey, value: 1, reason: "new scene at the sunlight sentence" });

    const recalled = await runRecall(dir, "b0001", { env });
    assert.equal(recalled.pinsHonored, 1);
    const files = await readdir(join(dir, "changesets"));
    assert.ok(
      files.some((f) => f.includes("superseded")),
      `superseded changeset kept: ${files}`,
    );
    const audit = await readFile(join(dir, "maintenance.jsonl"), "utf8");
    assert.match(audit, /"op":"recall"/);
  } finally {
    await jev.close();
  }
});
