import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BundleStore, type BundleManifest } from "../src/connectors/bundle.js";
import { listChangeSets } from "../src/merge/changesetStore.js";
import { initWorkspace } from "../src/workspace/init.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function tempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "novel-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function run(cwd: string, args: string[], model = "") {
  // Fail any accidental model request, even without credentials.
  const noNetwork = "data:text/javascript," + encodeURIComponent(
    'globalThis.fetch = () => { throw new Error("Unexpected network request"); };',
  );
  const result = spawnSync(process.execPath, ["--import", noNetwork, cli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      TYPESAFE_API_KEY: "",
      WORK_LLM_API_KEY: "",
      JEV_MODEL: model,
    },
  });
  assert.ifError(result.error);
  return result;
}

test("init creates a nested Unicode workspace without keys or model requests", async (t) => {
  const root = await tempRoot(t);
  const result = run(root, ["init", "novels/测试 novel"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const output = JSON.parse(result.stdout);
  const novelDir = join(root, "novels", "测试 novel");
  assert.equal(output.status, "initialized");
  assert.equal(output.novelDir, novelDir);
  assert.deepEqual((await readdir(novelDir)).sort(), ["branches", "changesets", "ontology", "source"]);

  const manifest: BundleManifest = JSON.parse(
    await readFile(join(novelDir, "ontology", "manifest.json"), "utf8"),
  );
  assert.match(manifest.novelId, /^novel_[0-9a-f-]{36}$/);
  assert.deepEqual(manifest, {
    novelId: manifest.novelId,
    title: "测试 novel",
    schemaVersion: 1,
    sourceLanguages: [],
    embeddingModel: null,
    embeddingDimension: null,
    decisionModel: "jev-1.13.0",
    blocksProcessed: 0,
  });
  assert.deepEqual(output.manifest, manifest);
  const files = [
    "branches.jsonl", "entities.jsonl", "events.jsonl", "relations.jsonl",
    "scenes.jsonl", "timelines.jsonl",
  ];
  assert.deepEqual((await readdir(join(novelDir, "ontology"))).sort(), [...files, "manifest.json"].sort());
  for (const file of files) {
    assert.equal(await readFile(join(novelDir, "ontology", file), "utf8"), "");
  }
  assert.deepEqual(await listChangeSets(novelDir), []);
  const bundle = new BundleStore(join(novelDir, "ontology"));
  await bundle.upsertEntity({
    id: "char_test", kind: "Character", names: [], properties: {}, confidence: 1,
  });
  assert.equal((await bundle.loadFile<{ id: string }>("entities.jsonl"))[0].id, "char_test");
});

test("init supports absolute paths, --pretty, and a configured model version", async (t) => {
  const root = await tempRoot(t);
  const novelDir = join(root, "pretty");
  const result = run(root, ["--pretty", "init", novelDir], "jev-test-pinned");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(result.stdout, JSON.stringify(output, null, 2) + "\n");
  assert.equal(output.manifest.decisionModel, "jev-test-pinned");
});

test("init refuses a populated workspace and preserves all existing bytes", async (t) => {
  const root = await tempRoot(t);
  const novelDir = join(root, "existing");
  await initWorkspace(novelDir);
  const manifestPath = join(novelDir, "ontology", "manifest.json");
  const entitiesPath = join(novelDir, "ontology", "entities.jsonl");
  const manifest = await readFile(manifestPath);
  await writeFile(entitiesPath, "existing data\n");
  const result = run(root, ["init", novelDir]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(JSON.parse(result.stderr).error, /EEXIST/);
  assert.deepEqual(await readFile(manifestPath), manifest);
  assert.equal(await readFile(entitiesPath, "utf8"), "existing data\n");
});

test("init refuses existing empty directories, files, and symlinks", async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, "empty"));
  await writeFile(join(root, "file"), "keep me");
  await symlink(join(root, "empty"), join(root, "link"));
  await symlink(join(root, "missing"), join(root, "dangling"));
  for (const path of ["empty", "file", "link", "dangling"]) {
    const result = run(root, ["init", path]);
    assert.equal(result.status, 1, path);
    assert.equal(result.stdout, "");
    assert.match(JSON.parse(result.stderr).error, /EEXIST/);
  }
  assert.deepEqual(await readdir(join(root, "empty")), []);
  assert.equal(await readFile(join(root, "file"), "utf8"), "keep me");
  assert.deepEqual((await readdir(root)).sort(), ["dangling", "empty", "file", "link"]);
});

test("init rejects missing paths, unsupported flags, and extra arguments as JSON errors", async (t) => {
  const root = await tempRoot(t);
  for (const args of [
    ["init"], ["init", "--pretty"], ["init", ""], ["init", "  "],
    ["init", "--force"], ["init", "novel", "extra"], ["init", "novel", "--force"],
  ]) {
    const result = run(root, args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.match(JSON.parse(result.stderr).error, /Usage: novel init/);
  }
  assert.deepEqual(await readdir(root), []);
});

test("concurrent initialization allows only one writer and generates distinct novel IDs", async (t) => {
  const root = await tempRoot(t);
  const novelDir = join(root, "race");
  const results = await Promise.allSettled([initWorkspace(novelDir), initWorkspace(novelDir)]);
  const successes = results.filter((r) => r.status === "fulfilled");
  assert.equal(successes.length, 1);
  const failure = results.find((r) => r.status === "rejected");
  assert.equal((failure?.reason as NodeJS.ErrnoException).code, "EEXIST");
  const first = JSON.parse(await readFile(join(novelDir, "ontology", "manifest.json"), "utf8"));
  const second = await initWorkspace(join(root, "other"));
  assert.notEqual(first.novelId, second.manifest.novelId);
});
