import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniloop } from "../src/autostep/miniloop.js";
import { MockDecisionModel } from "../src/connectors/jev.js";
import { sectionBlock } from "../src/text/sectioning.js";
import type { Entity } from "../src/ontology/types.js";
import type { DecisionModel } from "../src/connectors/jev.js";

const mikoto: Entity = {
  id: "char_000001",
  kind: "Character",
  names: [{ text: "御坂美琴", lang: "zh", kind: "canonical" }],
  properties: {},
  confidence: 1,
};

test("miniloop produces a pending ChangeSet and never a direct write", async () => {
  const text = "御坂美琴走进房间。「我们走吧。」她说。";
  const { sentences } = sectionBlock(text, 0);
  // Mock Jev: sentence 2 is dialogue; everything else narration.
  const table: Record<string, string | number> = {};
  for (const s of sentences) {
    table[`kind:${s.id}`] = s.index === 1 ? "dialogue" : "narration";
    table[`cont:${s.id}`] = 0;
    table[`boundary:${s.id}`] = 0;
  }
  table["present:char_000001"] = 1;

  const loop = new Miniloop(new MockDecisionModel(table));
  const result = await loop.runBlock({
    blockId: "b0000",
    sentences,
    knownEntities: [mikoto],
    stateSummary: "Test block.",
  });

  assert.equal(result.changeset.status, "pending_review");
  assert.equal(result.changeset.blockId, "b0000");
  // Dialogue detector grouped the dialogue sentence into a unit.
  const units = result.accepted["dialogueUnits"] as string[][];
  assert.ok(units.flat().includes(sentences[1].id));
  // Known-name code scan found Mikoto without any model call.
  const hits = result.accepted["nameHits"] as { entityId: string }[];
  assert.ok(hits.some((h) => h.entityId === "char_000001"));
});

test("presence candidates are window-local and absent carried characters are not invented mentions", async () => {
  const { sentences } = sectionBlock("御坂美琴走进教室。窗外下雨了。屋里安静下来。", 0);
  let presenceCalls = 0;
  const decisions: DecisionModel = {
    modelId: "window-local-test",
    async decide(_state, questions) {
      return questions.map((question) => {
        if (question.key.startsWith("present:")) {
          assert.ok(question.instructions.includes("御坂美琴"));
          presenceCalls++;
          return { key: question.key, value: presenceCalls === 1 ? 1 : 0, confidence: 1 };
        }
        return { key: question.key, value: question.primitive === "choice" ? "narration" : 0, confidence: 1 };
      });
    },
  };
  const result = await new Miniloop(decisions, { windowSize: 1 }).runBlock({ blockId: "b0001", sentences, knownEntities: [mikoto], stateSummary: "Test" });
  assert.equal(presenceCalls, 2);
  assert.deepEqual(result.windows.map((window) => window.charactersPresent), [[mikoto.id], [], []]);
  assert.deepEqual(result.windows.map((window) => window.charactersMentioned), [[], [], []]);
});

test("identity decisions receive name forms and cannot nominate an Organization as a Character alias", async () => {
  const { sentences } = sectionBlock("御坂美琴向白井黑子挥手。", 0);
  let checked = false;
  const decisions: DecisionModel = {
    modelId: "identity-context-test",
    async decide(state, questions) {
      const nickname = questions.find((question) => question.key === "nick:白井黑子");
      if (nickname) {
        checked = true;
        assert.ok(state.includes("char_000001: 御坂美琴"));
        assert.deepEqual(nickname.options, [mikoto.id, "none"]);
      }
      return questions.map((question) => ({ key: question.key, value: question.primitive === "choice" ? question.key.startsWith("nick:") ? "none" : "narration" : 0, confidence: 1 }));
    },
  };
  await new Miniloop(decisions, { refineNameCandidates: async () => ["白井黑子"] }).runBlock({ blockId: "b0001", sentences, knownEntities: [mikoto, { ...mikoto, id: "org_1", kind: "Organization" }], stateSummary: "Test" });
  assert.equal(checked, true);
});
