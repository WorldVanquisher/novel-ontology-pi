import { test } from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startWatch } from "../src/watch/server.js";
import { EventLog, cursorId } from "../src/events/log.js";
import type { EventRecord } from "../src/events/types.js";

async function stream(url: string, lastId?: string) {
  const frames: string[] = [];
  let buffer = "";
  const request = get(url, { headers: lastId ? { "Last-Event-ID": lastId } : {} });
  request.on("error", () => undefined);
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    request.once("response", resolve); request.once("error", reject);
  });
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      frames.push(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  });
  return {
    frames, response,
    records: () => frames.filter((f) => f.startsWith("id:")).map((f) => JSON.parse(f.split("\ndata: ")[1]) as EventRecord),
    close: () => { response.destroy(); request.destroy(); },
  };
}

async function until(check: () => boolean, message = "condition timed out") {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() > end) assert.fail(message); await delay(10); }
}

test("SSE replays in order, reconnects strictly after ID, accepts split UTF-8 append, and frees clients", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-sse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = new EventLog(root);
  const a = await log.append({ type: "block.started", blockId: "甲" });
  const b = await log.append({ type: "sectioned", blockId: "甲", sentences: 3 });
  const watch = await startWatch(root, { port: 0, pollMs: 10, heartbeatMs: 30 });
  t.after(() => watch.close());
  const client = await stream(watch.url);
  t.after(client.close);
  assert.equal(client.response.statusCode, 200);
  assert.match(String(client.response.headers["content-type"]), /text\/event-stream/);
  await until(() => client.records().length === 2);
  assert.deepEqual(client.records(), [a, b]);
  await until(() => client.frames.some((f) => f === ": heartbeat"));
  client.close();
  await until(() => watch.resources().clients === 0 && watch.resources().pollers === 0);
  const c = await log.append({ type: "block.started", blockId: "断线期间" });
  // Last-Event-ID takes precedence over the fresh-instance query cursor.
  const reconnect = await stream(`${watch.url}?after=${a.id}`, b.id);
  t.after(reconnect.close);
  await until(() => reconnect.records().length === 1);
  assert.deepEqual(reconnect.records(), [c]);
  // Build the fixture elsewhere, then append it in two writes. The server
  // never gets a chance to see the complete line before the split append.
  const fixtureDir = join(root, "fixture");
  await mkdir(fixtureDir);
  const fixtureLog = new EventLog(fixtureDir);
  await writeFile(fixtureLog.path, await readFile(log.path));
  const d = await fixtureLog.append({ type: "block.started", blockId: "半行汉字" });
  const bytes = await readFile(fixtureLog.path);
  const partialEnd = bytes.indexOf(Buffer.from("半行汉字"), Number(c.id)) + 1;
  await appendFile(log.path, bytes.subarray(Number(c.id), partialEnd));
  await delay(60);
  assert.deepEqual(reconnect.records(), [c]);
  await appendFile(log.path, bytes.subarray(partialEnd));
  await until(() => reconnect.records().length === 2);
  assert.deepEqual(reconnect.records(), [c, d]);
  const fresh = await stream(`${watch.url}?after=${c.id}`);
  t.after(fresh.close);
  await until(() => fresh.records().length === 1);
  assert.deepEqual(fresh.records(), [d]);
  await watch.close();
  await watch.close();
  assert.deepEqual(watch.resources(), { clients: 0, pollers: 0, jobs: 0 });
});

test("watch is read-only, loopback-only, waits for a new log, and rejects invalid replay cursors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-sse-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(startWatch(root, { host: "0.0.0.0" as "127.0.0.1" }), /loopback/);
  const watch = await startWatch(root, { port: 0, pollMs: 10 });
  t.after(() => watch.close());
  const client = await stream(watch.url);
  t.after(client.close);
  await delay(30);
  assert.deepEqual(await readdir(root), []); // not even an empty log created by watch
  assert.equal((await fetch(watch.url, { method: "POST" })).status, 405);
  assert.equal((await fetch(watch.url.replace("/events", "/approve"), { method: "POST" })).status, 404);
  assert.equal((await fetch(`${watch.url}?after=bad`)).status, 409);
  assert.equal((await fetch(`${watch.url}?after=${cursorId(1000)}`)).status, 409);
  const record = await new EventLog(root).append({ type: "block.started", blockId: "created-later" });
  await until(() => client.records().length === 1);
  assert.deepEqual(client.records(), [record]);
  assert.equal((await fetch(`${watch.url}?after=${cursorId(1)}`)).status, 409);
  // Local browser origins are usable without a wildcard granting remote sites access.
  const local = await fetch(watch.url, { headers: { Origin: "http://localhost:5173" } });
  assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:5173");
  await local.body!.cancel();
  const remote = await fetch(watch.url, { headers: { Origin: "https://example.com" } });
  assert.equal(remote.headers.get("access-control-allow-origin"), null);
  await remote.body!.cancel();
  await watch.close();
  assert.deepEqual(watch.resources(), { clients: 0, pollers: 0, jobs: 0 });
});

test("service shutdown releases a backpressured replay without waiting for a drain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-sse-slow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = new EventLog(root);
  for (let i = 0; i < 32; i++) await log.append({ type: "block.started", blockId: String(i) + "x".repeat(256 * 1024) });
  const watch = await startWatch(root, { port: 0, pollMs: 1 });
  t.after(() => watch.close());
  const request = get(watch.url);
  request.on("error", () => undefined);
  const response = await new Promise<import("node:http").IncomingMessage>((resolve) => request.once("response", resolve));
  response.pause();
  t.after(() => { response.destroy(); request.destroy(); });
  await until(() => watch.resources().clients === 1);
  await delay(100);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      watch.close(),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("shutdown waited for a slow client")), 3000); }),
    ]);
  } finally { clearTimeout(deadline); }
  assert.deepEqual(watch.resources(), { clients: 0, pollers: 0, jobs: 0 });
});

test("multi-batch replay joins concurrent live appends without gaps or duplicate IDs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-replay-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = new EventLog(root);
  // Explicit transport fixtures: this is not an ingestion scenario.
  const history = [];
  for (let i = 0; i < 18; i++) history.push(await log.append({ type: "block.started", blockId: `fixture-${i}:` + "x".repeat(128 * 1024) }));
  const watch = await startWatch(root, { port: 0, pollMs: 10 });
  t.after(() => watch.close());
  const client = await stream(watch.url);
  t.after(client.close);
  await until(() => client.records().length > 0);
  const live = await Promise.all(Array.from({ length: 8 }, (_, i) => log.append({ type: "sectioned", blockId: `fixture-live-${i}`, sentences: i })));
  await until(() => client.records().length === history.length + live.length);
  assert.deepEqual(client.records(), [...history, ...live]);
  assert.equal(new Set(client.records().map((r) => r.id)).size, history.length + live.length);
  const cursor = history[9].id;
  client.close();
  const reconnect = await stream(watch.url, cursor);
  t.after(reconnect.close);
  await until(() => reconnect.records().length === history.length - 10 + live.length);
  assert.deepEqual(reconnect.records(), [...history.slice(10), ...live]);
  await watch.close();
  assert.deepEqual(watch.resources(), { clients: 0, pollers: 0, jobs: 0 });
});

test("corruption, truncation and same-size file replacement disconnect without exposing raw log errors", async (t) => {
  for (const failure of ["corrupt", "truncate", "replace"] as const) {
    const root = await mkdtemp(join(tmpdir(), "novel-stream-failure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const log = new EventLog(root);
    const record = await log.append({ type: "block.started", blockId: "fixture" });
    const watch = await startWatch(root, { port: 0, pollMs: 10 });
    t.after(() => watch.close());
    const client = await stream(watch.url);
    t.after(client.close);
    await until(() => client.records().length === 1);
    if (failure === "corrupt") await appendFile(log.path, "fixture-secret-invalid-json\n");
    if (failure === "truncate") await writeFile(log.path, "");
    if (failure === "replace") {
      await writeFile(join(root, "replacement"), await readFile(log.path));
      await rename(join(root, "replacement"), log.path);
    }
    await until(() => client.response.destroyed && watch.resources().clients === 0 && watch.resources().jobs === 0);
    assert.deepEqual(client.records(), [record]);
    assert.ok(client.frames.every((frame) => !frame.includes("fixture-secret-invalid-json")));
    assert.deepEqual(watch.resources(), { clients: 0, pollers: 0, jobs: 0 });
    await watch.close();
  }
});
