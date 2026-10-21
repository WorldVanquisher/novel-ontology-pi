import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cutBlocks, splitChapters } from "../src/text/blocks.js";

const fixture = fileURLToPath(
  new URL("../../test/fixtures/sample-novel.txt", import.meta.url),
);

test("splitChapters finds front matter + 3 titled chapters", async () => {
  const text = await readFile(fixture, "utf8");
  const chapters = splitChapters(text);
  assert.equal(chapters.length, 4);
  assert.equal(chapters[0].title, null);
  assert.match(chapters[1].title ?? "", /第一章/);
  assert.match(chapters[2].title ?? "", /第二章/);
  assert.match(chapters[3].title ?? "", /第三章/);
  // Chapters tile the source exactly.
  assert.equal(chapters.map((c) => c.text).join(""), text);
});

test("cutBlocks respects size cap and stays consistent with source", async () => {
  const text = await readFile(fixture, "utf8");
  const blocks = cutBlocks(text, 200);
  assert.ok(blocks.length >= 4, `expected >=4 blocks, got ${blocks.length}`);
  blocks.forEach((b, i) => {
    assert.equal(b.id, `b${String(i + 1).padStart(4, "0")}`);
    assert.equal(b.text, text.slice(b.startOffset, b.endOffset));
    assert.equal(b.charCount, b.endOffset - b.startOffset);
    assert.ok(b.charCount <= 200, `block ${b.id} too big: ${b.charCount}`);
  });
  // Chapter indices never go backwards.
  for (let i = 1; i < blocks.length; i++) {
    assert.ok(blocks[i].chapterIndex >= blocks[i - 1].chapterIndex);
  }
});

test("one big target keeps one block per chapter", async () => {
  const text = await readFile(fixture, "utf8");
  const blocks = cutBlocks(text, 100000);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[3].chapterTitle?.includes("第三章"), true);
});
