import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalRun } from "../src/commands/evalCommands.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
// Tests run compiled, from dist/test/ — ../../ is the repo root.
const exampleDataset = fileURLToPath(new URL("../../eval/examples/golden-chapter", import.meta.url));
const examplePredictions = join(exampleDataset, "predictions");

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

test("shipped example dataset scores the documented numbers", async () => {
  const r = await evalRun(exampleDataset, examplePredictions);
  assert.deepEqual(r.kinds.entities, { tp: 2, fp: 1, fn: 1, precision: 0.6667, recall: 0.6667, f1: 0.6667 });
  assert.deepEqual(r.kinds.relations, { tp: 1, fp: 0, fn: 1, precision: 1, recall: 0.5, f1: 0.6667 });
  assert.deepEqual(r.kinds.events, { tp: 1, fp: 0, fn: 1, precision: 1, recall: 0.5, f1: 0.6667 });
  assert.deepEqual(r.overall, { tp: 4, fp: 1, fn: 3, precision: 0.8, recall: 0.5714, f1: 0.6667 });
  assert.deepEqual(r.missed.map((m) => m.key), [
    "entity:Location:Station Platform",
    "event:tl_canon:the train leaves without mara and tobin",
    "relation:KNOWS:entity:Character:Mara Voss->entity:Character:Tobin Hale",
  ]);
  assert.deepEqual(r.spurious.map((s) => s.key), ["entity:Character:Stationmaster"]);
});

test("perfect predictions score 1 across the board", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-eval-perfect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const predictions = join(root, "predictions");
  await mkdir(predictions);
  // cp copies golden/'s contents (the ch01/ chapter dir) into predictions/.
  await cp(join(exampleDataset, "golden"), predictions, { recursive: true });
  const perfect = await evalRun(exampleDataset, predictions);
  assert.equal(perfect.overall.precision, 1);
  assert.equal(perfect.overall.recall, 1);
  assert.equal(perfect.overall.f1, 1);
  assert.deepEqual(perfect.missed, []);
  assert.deepEqual(perfect.spurious, []);
});

test("id pass: recorded predictions with golden ids match even if text differs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-eval-idpass-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const predDir = join(root, "predictions", "ch01");
  await mkdir(predDir, { recursive: true });
  await writeFile(join(predDir, "entities.jsonl"),
    JSON.stringify({ id: "char_mara", kind: "Character", names: [{ text: "Renamed Entirely", lang: "en", kind: "canonical" }], properties: {}, confidence: 1 }) + "\n");
  await writeFile(join(predDir, "relations.jsonl"), "");
  await writeFile(join(predDir, "events.jsonl"), "");
  const r = await evalRun(exampleDataset, join(root, "predictions"));
  assert.equal(r.kinds.entities.tp, 1); // matched by id, not by name
  assert.equal(r.kinds.entities.fn, 2);
});

test("empty predictions: recall 0, every golden record missed, no pass/fail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-eval-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const predictions = join(root, "predictions");
  await mkdir(predictions);
  const r = await evalRun(exampleDataset, predictions);
  assert.deepEqual(r.overall, { tp: 0, fp: 0, fn: 7, precision: null, recall: 0, f1: null });
  assert.equal(r.missed.length, 7);
  assert.deepEqual(r.spurious, []);
});

test("malformed predictions produce specific errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-eval-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const predDir = join(root, "predictions", "ch01");
  await mkdir(predDir, { recursive: true });
  await writeFile(join(predDir, "entities.jsonl"), "");
  await writeFile(join(predDir, "relations.jsonl"), "");
  await writeFile(join(predDir, "events.jsonl"),
    JSON.stringify({ id: "e1", timelineId: "tl_canon", summaryEn: "x" }) + "\n{broken}\n");
  await assert.rejects(
    () => evalRun(exampleDataset, join(root, "predictions")),
    /corrupt JSONL in predictions chapter "ch01": .*events\.jsonl line 2/,
  );
  // Unknown record kinds are rejected, not silently skipped.
  await writeFile(join(predDir, "events.jsonl"), "");
  await writeFile(join(predDir, "scenes.jsonl"), "{}\n");
  await assert.rejects(
    () => evalRun(exampleDataset, join(root, "predictions")),
    /unknown record file in predictions chapter "ch01": .*scenes\.jsonl/,
  );
});

test("CLI: eval run prints JSON, --pretty works, usage errors exit 1", async () => {
  const ok = runCli(["eval", "run", exampleDataset, examplePredictions]);
  assert.equal(ok.status, 0, ok.stderr); // scoring always exits 0, whatever the numbers
  assert.equal(JSON.parse(ok.stdout).overall.tp, 4);
  const pretty = runCli(["eval", "run", exampleDataset, examplePredictions, "--pretty"]);
  assert.equal(pretty.status, 0, pretty.stderr);
  assert.ok(pretty.stdout.includes("\n  \"kinds\""));
  const usage = runCli(["eval", "run", exampleDataset]);
  assert.equal(usage.status, 1);
  assert.match(JSON.parse(usage.stderr).error, /Usage: novel eval run/);
  const missing = runCli(["eval", "run", exampleDataset, join(exampleDataset, "no-such-dir")]);
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stderr).error, /predictions directory not found/);
});
