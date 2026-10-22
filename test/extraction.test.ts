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

test("extraction preserves source-language summaries, names, and state facts", async () => {
  const summary = "御坂美琴得知白井黑子要去巡逻。";
  const { work, input } = makeInput({
    text: "白井黑子说道：「我先去巡逻了。」御坂美琴点头。",
    reply: JSON.stringify({
      newEntities: [{ name: "白井黑子", kind: "Character", aliases: [{ text: "黑子", kind: "nickname" }] }],
      events: [{
        summaryEn: summary,
        actors: ["白井黑子"],
        affected: ["御坂美琴"],
        stateChanges: [{ character: "御坂美琴", knowledgeAdd: ["白井黑子要去巡逻"], goalsAdd: ["留在教室"] }],
      }],
    }),
  });
  const out = await createExtractor(work)(input);
  const event = out.proposals.find((proposal) => proposal.kind === "create_event")?.payload as OntEvent;
  assert.equal(event.summaryEn, summary);
  const entity = out.proposals.find((proposal) => proposal.kind === "upsert_entity")?.payload as Entity;
  assert.deepEqual(entity.names.map((name) => name.text), ["白井黑子", "黑子"]);
  const state = out.proposals.find((proposal) => proposal.kind === "set_state_change")?.payload as { knowledgeAdd: string[]; goalsAdd: string[] };
  assert.deepEqual(state.knowledgeAdd, ["白井黑子要去巡逻"]);
  assert.deepEqual(state.goalsAdd, ["留在教室"]);
});

test("reviewer constraints prevent cross-identity alias folding and placeholder actors", async () => {
  const { work, input } = makeInput({
    text: "御坂美琴向食蜂操祈挥手。有人说话。",
    reply: JSON.stringify({
      newEntities: [
        { name: "食蜂操祈", aliases: [{ text: "御坂美琴" }, { text: "食蜂" }] },
        { name: "unknown" },
      ],
      events: [{ summaryEn: "御坂美琴向食蜂操祈挥手。", actors: ["御坂美琴", "食蜂操祈", "unknown"], stateChanges: [{ character: "unknown", goalsAdd: ["说话"] }] }],
    }),
  });
  const out = await createExtractor(work)({ ...input, constraints: { distinctNames: [["御坂美琴", "食蜂操祈"]], rejectCharacterNames: ["unknown"] } });
  const entities = out.proposals.filter((proposal) => proposal.kind === "upsert_entity").map((proposal) => proposal.payload as Entity);
  assert.equal(entities.length, 1);
  assert.deepEqual(entities[0].names.map((name) => name.text), ["食蜂操祈", "食蜂"]);
  const event = out.proposals.find((proposal) => proposal.kind === "create_event")!.payload as OntEvent;
  assert.deepEqual(event.primaryActors, [mikoto.id, entities[0].id]);
  assert.equal(out.proposals.filter((proposal) => proposal.kind === "set_state_change").length, 0);
  assert.ok(out.notes["recall:pin:extraction:constraints"]);
  assert.ok(Object.keys(out.notes).some((key) => key.startsWith("extraction:alias-conflict:")));
});

test("new entities do not reuse approved ids removed by maintenance", async () => {
  const { work, input } = makeInput({ text: "小樱走进教室。", known: [], reply: JSON.stringify({ newEntities: [{ name: "小樱" }], events: [] }) });
  const out = await createExtractor(work)({ ...input, counts: { events: 0, scenes: 0, reservedEntityIds: ["char_000099"] } });
  assert.equal((out.proposals.find((proposal) => proposal.kind === "upsert_entity")!.payload as Entity).id, "char_000100");
});

test("later scene prompts carry newly discovered identities without implying their presence", async () => {
  let scene = 0;
  const { work, input, ids } = makeInput({
    text: "白井黑子走进教室。窗外下雨了。",
    known: [],
    reply: (request) => {
      scene++;
      if (scene === 1) return JSON.stringify({ newEntities: [{ name: "白井黑子" }], events: [] });
      assert.ok(request.prompt.includes("白井黑子"));
      return JSON.stringify({ events: [{ summaryEn: "窗外下雨了。", actors: [] }] });
    },
  });
  input.miniloop.accepted["sceneSpans"] = ids.map((id) => [id]);
  const out = await createExtractor(work)(input);
  assert.equal(scene, 2);
  const scenes = out.proposals.filter((proposal) => proposal.kind === "create_scene").map((proposal) => proposal.payload as Scene);
  assert.deepEqual(scenes[1].charactersPresent, []);
});

test("scene rosters do not promote name mentions, event actors or window-wide candidates to physical presence", async () => {
  const { work, input, ids } = makeInput({
    text: "旁人提起御坂美琴的旧事。窗外下雨了。",
    reply: (request) => JSON.stringify({ charactersPresent: [], charactersMentioned: request.prompt.includes(`${ids[0]}:`) ? ["御坂美琴"] : [], events: [{ summaryEn: "提到过去。", actors: ["御坂美琴"] }] }),
  });
  input.miniloop.accepted["nameHits"] = [{ entityId: mikoto.id, sentenceId: ids[0], form: "御坂美琴" }];
  input.miniloop.accepted["sceneSpans"] = ids.map((id) => [id]);
  input.miniloop.windows = [{ sentenceIds: ids, charactersPresent: [mikoto.id], charactersMentioned: [mikoto.id], turns: [], dialogueUnits: [] }];
  const result = await createExtractor(work)(input);
  const scenes = result.proposals.filter((proposal) => proposal.kind === "create_scene").map((proposal) => proposal.payload as Scene);
  assert.deepEqual(scenes.map((scene) => scene.charactersPresent), [[], []]);
  assert.deepEqual(scenes.map((scene) => scene.charactersMentioned), [[mikoto.id], []]);
});

test("extraction cannot steal a new character's alias or put other kinds in Character slots", async () => {
  const { work, input, ids } = makeInput({
    text: "月咏小萌在学校讲话。",
    known: [mikoto, { ...mikoto, id: "org_1", kind: "Organization", names: [{ text: "学校", kind: "canonical", lang: "zh" }] }],
    proposals: [{ id: "wrong_alias", kind: "add_alias", payload: { entityId: mikoto.id, aliasText: "小萌老师" }, confidence: 0.8, provenance: { blockId: "b0001", sentenceIds: [], patchId: "alias" } }],
    reply: JSON.stringify({ locationName: "学校", newEntities: [{ name: "月咏小萌", aliases: [{ text: "小萌老师" }] }], events: [{ summaryEn: "月咏小萌讲话。", actors: ["月咏小萌", "学校"], stateChanges: [{ character: "学校", knowledgeAdd: ["不应作为角色状态"] }] }] }),
  });
  input.miniloop.windows = [{ sentenceIds: ids, charactersPresent: ["org_1"], charactersMentioned: ["org_1"], turns: [{ speakerId: "org_1", addresseeId: "org_1", sentenceIds: ids }] }] as MiniloopResult["windows"];
  const out = await createExtractor(work)(input);
  assert.ok(!out.proposals.some((proposal) => proposal.kind === "upsert_entity" && (proposal.payload as Entity).id === mikoto.id));
  assert.ok(out.notes.wrong_alias);
  const scene = out.proposals.find((proposal) => proposal.kind === "create_scene")!.payload as Scene;
  assert.ok(!scene.charactersPresent.includes("org_1"));
  assert.ok(!scene.charactersMentioned.includes("org_1"));
  assert.equal(scene.locationId, null);
  assert.equal(scene.turns[0].speakerId, null);
  assert.equal(scene.turns[0].addresseeId, null);
  assert.equal(out.proposals.filter((proposal) => proposal.kind === "set_state_change").length, 0);
  const event = out.proposals.find((proposal) => proposal.kind === "create_event")!.payload as OntEvent;
  assert.ok(!event.primaryActors.includes("org_1"));
});

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
      assert.match(req.prompt, /WINDOW CAST HINTS/);
      return JSON.stringify({
        locationName: "教室",
        charactersPresent: ["御坂美琴"],
        charactersMentioned: [],
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
