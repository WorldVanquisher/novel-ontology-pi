import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleStore } from "../src/connectors/bundle.js";

test("loadFile reports the filename and physical line of corrupt JSONL", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "events.jsonl"), '{"id":"ev_1"}\n\n \t\r\n{malformed}\n');

  await assert.rejects(
    new BundleStore(root).loadFile("events.jsonl"),
    /corrupt JSONL in events\.jsonl line 4: SyntaxError:/,
  );
});

test("loadFile returns an empty array for a missing optional file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await new BundleStore(root).loadFile("branches.jsonl"), []);
});

test("loadFile preserves valid records and ignores blank lines", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = [
    { id: "ev_1", extra: { text: "角色", values: [1, false, null] } },
    { id: "ev_2", summaryEn: "unchanged" },
  ];
  await writeFile(
    join(root, "events.jsonl"),
    `\n \t\r\n${JSON.stringify(records[0])}\r\n\n${JSON.stringify(records[1])}`,
  );

  assert.deepEqual(await new BundleStore(root).loadFile("events.jsonl"), records);
});

test("loadFile returns an empty array for empty and blank-only files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const raw of ["", "\n \t\r\n\n"]) {
    await writeFile(join(root, "events.jsonl"), raw);
    assert.deepEqual(await new BundleStore(root).loadFile("events.jsonl"), []);
  }
});

test("loadFile propagates non-ENOENT read failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "not-a-directory"), "");
  const file = "not-a-directory/events.jsonl";

  await assert.rejects(new BundleStore(root).loadFile(file), {
    code: "ENOTDIR",
    path: join(root, file),
  });
});
