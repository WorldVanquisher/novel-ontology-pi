import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { newChangeSet } from "../src/merge/changeset.js";
import { listChangeSets, saveChangeSet } from "../src/merge/changesetStore.js";
import { reviewPage } from "../src/merge/reviewPage.js";

const execute = promisify(execFile);

test("review pagination covers every proposal and note, including the final partial page", () => {
  const changeset = newChangeSet("b0001");
  changeset.proposals = Array.from({ length: 43 }, (_, index) => ({ id: `p${index}`, kind: "set_state_change", payload: {}, confidence: 0.7, provenance: { blockId: "b0001", sentenceIds: [], patchId: "test" } }));
  changeset.reviewNotes = { one: "first", two: "second" };
  const ids = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = reviewPage(changeset, { offset, limit: 20 });
    assert.ok("proposals" in page && page.proposals);
    ids.push(...page.proposals.map((proposal) => proposal.id));
    offset = page.page!.nextOffset;
  }
  assert.deepEqual(ids, changeset.proposals.map((proposal) => proposal.id));
  const notePage = reviewPage(changeset, { notes: true, offset: 1, limit: 1 });
  assert.ok("reviewNotes" in notePage);
  assert.deepEqual(notePage.reviewNotes, { two: "second" });
  assert.equal(reviewPage(changeset, { summary: true }).totalProposals, 43);
  for (const options of [{ offset: -1 }, { limit: 0 }, { limit: 101 }, { offset: NaN }]) assert.throws(() => reviewPage(changeset, options));
});

test("CLI review pages are bounded, validated, and read-only", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "novel-review-page-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const changeset = newChangeSet("b0001");
  changeset.proposals = Array.from({ length: 4 }, (_, index) => ({ id: `p${index}`, kind: "set_state_change", payload: {}, confidence: 0.7, provenance: { blockId: "b0001", sentenceIds: [], patchId: "test" } }));
  const file = await saveChangeSet(directory, changeset);
  await copyFile(file, join(directory, "changesets", "cs_b0001.superseded-test.json"));
  assert.deepEqual((await listChangeSets(directory)).map((entry) => entry.id), [changeset.id]);
  const before = await readFile(file, "utf8");
  const args = [resolve("dist/src/cli.js"), "changeset", "show", directory, changeset.id];
  const result = JSON.parse((await execute(process.execPath, [...args, "--offset", "2", "--limit", "2"])).stdout);
  assert.deepEqual(result.proposals.map((proposal: { id: string }) => proposal.id), ["p2", "p3"]);
  assert.equal(result.page.nextOffset, null);
  assert.equal(result.totalProposals, 4);
  await assert.rejects(execute(process.execPath, [...args, "--limit", "0"]));
  await assert.rejects(execute(process.execPath, [...args, "--offset", "1.5"]));
  assert.equal(await readFile(file, "utf8"), before);
});
