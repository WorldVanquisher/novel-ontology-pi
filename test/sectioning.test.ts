import { test } from "node:test";
import assert from "node:assert/strict";
import { sectionBlock } from "../src/text/sectioning.js";

test("CJK sentences split on terminal punctuation, quotes absorbed", () => {
  const text = "御坂美琴走进咖啡店。「你来了。」她说道。窗外下着雨。";
  const { sentences } = sectionBlock(text, 0);
  // Quote and its attribution tag are separate sentences at this stage;
  // stitching them into one dialogue unit is the dialogue patch's job.
  assert.equal(sentences.length, 4);
  assert.ok(sentences[0].text.endsWith("。"));
  assert.ok(sentences[1].text.includes("你来了"));
  assert.ok(sentences[1].text.includes("。」"));
  // IDs are stable and offsets are ordered
  assert.equal(sentences[0].id, "b0000_s0000");
  assert.ok(sentences[1].startOffset > sentences[0].startOffset);
});

test("English abbreviations and decimals do not split", () => {
  const text = "Dr. Smith paid 3.5 dollars. He left at once.";
  const { sentences } = sectionBlock(text, 1);
  assert.equal(sentences.length, 2);
  assert.ok(sentences[0].text.startsWith("Dr. Smith"));
});

test("paragraphs are tracked", () => {
  const text = "第一段。\n\n第二段开始！真的吗？";
  const { sentences, paragraphCount } = sectionBlock(text, 2);
  assert.equal(paragraphCount, 2);
  assert.equal(sentences.length, 3);
  assert.equal(sentences[2].paragraphIndex, 1);
});
