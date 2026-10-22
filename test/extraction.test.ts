import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtractor, createCandidateRefiner } from "../src/extraction/extraction.js";
import { nominateCandidateSpans } from "../src/autostep/patches/name-detector.js";
import { sectionBlock } from "../src/text/sectioning.js";
import { newChangeSet, type ChangeProposal } from "../src/merge/changeset.js";
import type { MiniloopResult } from "../src/autostep/miniloop.js";
import type { WorkModel } from "../src/connectors/llm.js";
import type { Entity, OntEvent, Scene } from "../src/ontology/types.js";

const mikoto: Entity = {
  id: "char_000001",
  kind: "Character",
  names: [{ text: "御坂美琴", lang: "zh", kind: "canonical" }],
  properties: {},
  confidence: 1,
};

function stubWork(reply: string | ((req: { system: string; prompt: string }) => string)): WorkModel {
  return {
    modelId: "stub",
    generate: async (req) => (typeof reply === "function" ? reply(req) : reply),
  };
}

function makeInput(opts: {
  text: string;
  proposals?: ChangeProposal[];
  known?: Entity[];
  reply: string | ((req: { system: string; prompt: string }) => string);
}) {
  const { sentences } = sectionBlock(opts.text, 0);
  const ids = sentences.map((s) => s.id);
  const miniloop: MiniloopResult = {
    changeset: newChangeSet("b0001"),
    escalations: [],
    accepted: { sceneSpans: [ids], nameHits: [] },
    windows: [],
  };
  return {
    work: stubWork(opts.reply),
    input: {
      blockId: "b0001",
      chapterIndex: 0,
      sentences,
      miniloop,
      knownEntities: opts.known ?? [mikoto],
      proposals: opts.proposals ?? [],
      counts: { events: 0, scenes: 0 },
    },
    ids,
  };
}

test("nomination: suffix and speech-verb patterns nominate; known names never do", () => {
  const sentences = [
    { id: "s1", text: "小樱小姐走进教室，环顾四周。" },
    { id: "s2", text: "白井黑子说道：「我先去巡逻了。」" },
    { id: "s3", text: "御坂美琴小姐笑了起来。" },
    { id: "s4", text: "姐姐大人今天不在。" },
  ];
  const noms = nominateCandidateSpans(sentences, [mikoto]);
  const spans = noms.map((n) => n.span);
  assert.ok(spans.includes("小樱"), `suffix nomination: ${spans}`);
  assert.ok(spans.includes("白井黑子"), `speech-verb nomination: ${spans}`);
  assert.ok(!spans.includes("御坂美琴"), "known name is a scan hit, not a candidate");
  assert.ok(!spans.includes("姐姐"), "generic spans are filtered");
});

test("extraction turns one scene into events, relations, a scene record, and state deltas", async () => {
  const { work, input, ids } = makeInput({
    text: "御坂美琴走进教室。她坐下来，拿出了课本。",
    reply: (req) => {
      // The prompt must carry the structured scene, not a raw chapter.
      assert.match(req.prompt, /KNOWN CAST/);
      return JSON.stringify({
        locationName: "教室",
        events: [
          {
            summaryEn: "Mikoto enters the classroom",
            eventType: "movement",
            importance: 0.4,
            actors: ["御坂美琴"],
            affected: [],
            evidence: [ids[0]],
            causes: null,
            stateChanges: [
              { character: "御坂美琴", emotions: { calm: 0.2 }, knowledgeAdd: [], goalsAdd: [], relationships: {}, location: "教室", possessionsAdd: [], possessionsRemove: [] },
            ],
          },
          {
            summaryEn: "Mikoto takes out her textbook",
            eventType: "action",
            importance: 0.3,
            actors: ["御坂美琴"],
            affected: [],
            evidence: [ids[1]],
            causes: 0,
            stateChanges: [],
          },
        ],
        newEntities: [],
      });
    },
  });
  const out = await createExtractor(work)(input);
  const kinds = out.proposals.map((p) => p.kind);
  assert.ok(kinds.includes("create_scene"));
  assert.equal(kinds.filter((k) => k === "create_event").length, 2);
  const scene = out.proposals.find((p) => p.kind === "create_scene")?.payload as Scene;
  assert.equal(scene.id, "scene_000001");
  assert.ok(scene.locationId, "location resolved to an entity");
  assert.ok(scene.charactersPresent.includes("char_000001"));
  const events = out.proposals
    .filter((p) => p.kind === "create_event")
    .map((p) => p.payload as OntEvent);
  assert.equal(events[0].timelineId, "tl_canon");
  assert.equal(events[0].chronologicalOrder, 1);
  assert.equal(events[1].chronologicalOrder, 2);
  assert.deepEqual(events[0].primaryActors, ["char_000001"]);
  assert.equal(events[0].evidence.text, "御坂美琴走进教室。");
  const rels = out.proposals.filter((p) => p.kind === "add_relation").map((p) => p.payload as { type: string; fromId: string; toId: string });
  assert.ok(rels.some((r) => r.type === "CAUSES" && r.fromId === events[0].id && r.toId === events[1].id));
  assert.ok(rels.some((r) => r.type === "PARTICIPATES_IN" && r.fromId === "char_000001"));
  const state = out.proposals.find((p) => p.kind === "set_state_change")?.payload as { characterId: string; afterEventId: string; location: string };
  assert.equal(state.characterId, "char_000001");
  assert.equal(state.afterEventId, events[0].id);
  // The minted Location is proposed as an entity too.
  assert.ok(out.proposals.some((p) => p.kind === "upsert_entity" && (p.payload as Entity).kind === "Location"));
});

test("extraction fleshes a Jev stub, drops an unconfirmed stub with a note, folds aliases", async () => {
  const stub: ChangeProposal = {
    id: "b0001_newchar_0",
    kind: "upsert_entity",
    payload: { candidateName: "白井黑子", needsExtraction: true },
    confidence: 0.93,
    provenance: { blockId: "b0001", sentenceIds: [], patchId: "name-detector" },
  };
  const ghostStub: ChangeProposal = {
    id: "b0001_newchar_1",
    kind: "upsert_entity",
    payload: { candidateName: "不存在子", needsExtraction: true },
    confidence: 0.88,
    provenance: { blockId: "b0001", sentenceIds: [], patchId: "name-detector" },
  };
  const alias: ChangeProposal = {
    id: "b0001_alias_2",
    kind: "add_alias",
    payload: { entityId: "char_000001", aliasText: "美琴" },
    confidence: 0.8,
    provenance: { blockId: "b0001", sentenceIds: [], patchId: "name-detector" },
  };
  const { work, input } = makeInput({
    text: "御坂美琴和白井黑子走进教室。",
    proposals: [stub, ghostStub, alias],
    reply: JSON.stringify({
      locationName: null,
      events: [
        { summaryEn: "Mikoto and Kuroko enter", eventType: "movement", importance: 0.5, actors: ["御坂美琴", "白井黑子"], affected: [], evidence: [], causes: null, stateChanges: [] },
      ],
      newEntities: [{ name: "白井黑子", kind: "Character", aliases: [{ text: "黑子", kind: "nickname" }] }],
    }),
  });
  const out = await createExtractor(work)(input);
  const fleshed = out.proposals.find((p) => p.id === "b0001_newchar_0");
  assert.ok(fleshed, "stub proposal survives, fleshed");
  const entity = fleshed!.payload as Entity;
  assert.equal(entity.kind, "Character");
  assert.deepEqual(entity.names.map((n) => n.text), ["白井黑子", "黑子"]);
  assert.equal(fleshed!.confidence, 0.93, "stub keeps its Jev confidence");
  assert.ok(!out.proposals.some((p) => p.id === "b0001_newchar_1"), "unconfirmed stub dropped");
  assert.match(out.notes["b0001_newchar_1"] ?? "", /did not confirm/);
  assert.ok(!out.proposals.some((p) => p.kind === "add_alias"), "alias folded, not passed through");
  const folded = out.proposals.find(
    (p) => p.kind === "upsert_entity" && (p.payload as Entity).id === "char_000001",
  );
  assert.ok(folded, "alias fold upserts the known entity");
  assert.ok((folded!.payload as Entity).names.some((n) => n.text === "美琴"));
});

test("a 'new' entity whose alias is already known folds into that entity — no duplicate mint", async () => {
  const shokuhou: Entity = {
    id: "char_000009",
    kind: "Character",
    names: [{ text: "食蜂操祈", lang: "zh", kind: "canonical" }],
    properties: {},
    confidence: 1,
  };
  const { work, input } = makeInput({
    text: "食蜂站在窗边，看着楼下的御坂美琴。",
    known: [mikoto, shokuhou],
    reply: JSON.stringify({
      locationName: null,
      events: [
        { summaryEn: "Shokuhou watches Mikoto from the window", eventType: "action", importance: 0.5, actors: ["食蜂"], affected: ["御坂美琴"], evidence: [], causes: null, stateChanges: [] },
      ],
      // Canonical form is the short name; the alias is the known entity.
      newEntities: [{ name: "食蜂", kind: "Character", aliases: [{ text: "食蜂操祈", kind: "alias" }] }],
    }),
  });
  const out = await createExtractor(work)(input);
  const upserts = out.proposals.filter((p) => p.kind === "upsert_entity");
  assert.equal(upserts.length, 1, "exactly one upsert: the fold, not a mint");
  const folded = upserts[0].payload as Entity;
  assert.equal(folded.id, "char_000009");
  assert.deepEqual(folded.names.map((n) => n.text), ["食蜂操祈", "食蜂"]);
  const ev = out.proposals.find((p) => p.kind === "create_event")?.payload as OntEvent;
  assert.deepEqual(ev.primaryActors, ["char_000009"], "actor '食蜂' resolves to the known entity");
});

test("extraction survives unparseable model output and notes it", async () => {
  const { work, input } = makeInput({
    text: "御坂美琴走进教室。",
    reply: "I am a language model and I refuse to JSON today.",
  });
  const out = await createExtractor(work)(input);
  assert.equal(out.proposals.filter((p) => p.kind === "create_event").length, 0);
  assert.ok(Object.values(out.notes).some((n) => /unparseable/.test(n)));
});

test("candidate refiner expands spans, drops NONEs, and falls back on failure", async () => {
  const sentences = [
    { id: "s1", text: "美琴小姐走了进来。" },
    { id: "s2", text: "大家先生请坐。" },
  ];
  const nominations = [
    { span: "美琴", sentenceId: "s1" },
    { span: "大家", sentenceId: "s2" },
  ];
  const refine = createCandidateRefiner(
    stubWork("1: 御坂美琴\n2: NONE"),
  );
  assert.deepEqual(await refine(nominations, sentences as never), ["御坂美琴"]);
  const failing = createCandidateRefiner({
    modelId: "stub",
    generate: async () => {
      throw new Error("down");
    },
  });
  assert.deepEqual(await failing(nominations, sentences as never), ["美琴", "大家"]);
});
