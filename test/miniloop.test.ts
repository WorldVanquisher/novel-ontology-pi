import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniloop } from "../src/autostep/miniloop.js";
import { MockDecisionModel } from "../src/connectors/jev.js";
import { sectionBlock } from "../src/text/sectioning.js";
import type { Entity } from "../src/ontology/types.js";

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
