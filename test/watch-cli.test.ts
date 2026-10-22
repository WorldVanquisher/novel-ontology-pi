import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { buildGraphFromBundle } from "../src/connectors/ladybug.js";
import { EventLog, readEventBatch } from "../src/events/log.js";
import { newChangeSet } from "../src/merge/changeset.js";
import { saveChangeSet, loadChangeSet } from "../src/merge/changesetStore.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("CLI watch exits cleanly on SIGTERM; it rejects public bind options", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-watch-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [cli, "watch", root, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  const deadline = Date.now() + 5000;
  while (!output.includes("\n")) {
    if (child.exitCode !== null || Date.now() > deadline) assert.fail("watch did not start");
    await delay(10);
  }
  const { url, readOnly } = JSON.parse(output);
  assert.equal(readOnly, true);
  assert.match(url, /^http:\/\/127\.0\.0\.1:/);
  const client = await fetch(url);
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  // The server intentionally closes an active SSE connection on shutdown.
  await client.body!.cancel().catch(() => undefined);
  const invalid = spawn(process.execPath, [cli, "watch", root, "--host", "0.0.0.0"], { stdio: "ignore" });
  assert.equal((await once(invalid, "exit"))[0], 1);
});

test("real CLI approval emits approved, merged and rebuilt separately; failed graph rebuild emits no success", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-graph-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ontology = join(root, "ontology");
  await mkdir(ontology);
  const cs = newChangeSet("b1");
  cs.status = "pending_review";
  cs.proposals = [{
    id: "fixture-p1", kind: "upsert_entity", confidence: 1,
    payload: { id: "char_fixture", kind: "Character", names: [{ text: "Fixture", lang: "en", kind: "canonical" }], properties: {}, confidence: 1 },
    provenance: { blockId: "b1", sentenceIds: ["s1"], patchId: "fixture" },
  }];
  await saveChangeSet(root, cs);
  const child = spawn(process.execPath, [cli, "changeset", "approve", root, cs.id], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.equal((await loadChangeSet(root, cs.id)).status, "approved");
  const log = new EventLog(root);
  assert.deepEqual((await readEventBatch(log.path, 0)).map((r) => r.event.type), [
    "proposal.added", "changeset.pending", "changeset.approved", "changeset.applied", "changeset.merged", "graph.rebuilt",
  ]);
  const before = await readFile(log.path, "utf8");
  await writeFile(join(ontology, "entities.jsonl"), "{malformed}\n");
  await assert.rejects(buildGraphFromBundle(ontology, join(ontology, "graph.lbug"), log.emit));
  assert.equal(await readFile(log.path, "utf8"), before);
  // Failure closes both native connection and database; the same path reopens.
  await writeFile(join(ontology, "entities.jsonl"), "");
  await buildGraphFromBundle(ontology, join(ontology, "graph.lbug"), log.emit);
  assert.equal((await readEventBatch(log.path, 0)).at(-1)!.event.type, "graph.rebuilt");
});
