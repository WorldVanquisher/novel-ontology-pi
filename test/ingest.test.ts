import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../src/workspace/init.js";
import { ingestNovel } from "../src/commands/ingestCommands.js";
import { listChangeSets } from "../src/merge/changesetStore.js";

/**
 * End-to-end ingest over a LOOPBACK Jev wire mock: the real JevClient
 * speaks to a local HTTP server that answers every question in the real
 * System One wire format. No live key, no model spend — but the CLI's
 * full path (key resolution -> client -> miniloop -> gate -> bundle ->
 * graph rebuild -> event log) is exercised for real.
 */

const FAKE_KEY = ["sk", "test", "fake", "key", "ingest"].join("-");

interface MockJev {
  url: string;
  seenKeys: string[];
  close: () => Promise<void>;
}

async function startMockJev(): Promise<MockJev> {
  const seenKeys: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as {
        questions: Record<string, { type: string; criteria?: Record<string, string> }>;
      };
      const answers: Record<string, unknown> = {};
      for (const [key, q] of Object.entries(parsed.questions)) {
        seenKeys.push(key);
        if (q.type === "noul") {
          answers[key] = { noul: key.startsWith("present:") ? 0.97 : 0.1 };
        } else if (q.type === "choice") {
          const options = Object.keys(q.criteria ?? {});
          const pick = options.includes("narration")
            ? "narration"
            : options.includes("none")
              ? "none"
              : options[0];
          answers[key] = { choice: pick, probabilities: { [pick]: 1 }, confidence: 0.9 };
        } else {
          answers[key] = { score: 1, confidence: 0.9 };
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock Jev: no address");
  return {
    url: `http://127.0.0.1:${addr.port}/v1/systemone`,
    seenKeys,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const NOVEL_TEXT = [
  "第一章　教室的早晨",
  "御坂美琴走进教室。她环顾四周，在靠窗的位置坐了下来。",
  "「今天也要努力。」她小声说道。窗外传来阵阵蝉鸣。",
  "",
  "第二章　放学后的街道",
  "御坂美琴走在回宿舍的路上。夕阳把街道染成金色。",
  "她停下脚步，看着远处的天空。",
].join("\n");

const SEED_ENTITY = {
  id: "char_000001",
  kind: "Character",
  names: [{ text: "御坂美琴", lang: "zh", kind: "canonical" }],
  properties: {},
  confidence: 1,
};

async function makeNovel(): Promise<{ dir: string; file: string }> {
  const parent = await mkdtemp(join(tmpdir(), "novel-ingest-"));
  const dir = join(parent, "novel");
  await initWorkspace(dir);
  await appendFile(
    join(dir, "ontology", "entities.jsonl"),
    JSON.stringify(SEED_ENTITY) + "\n",
  );
  const file = join(dir, "chapter.txt");
  await writeFile(file, NOVEL_TEXT);
  return { dir, file };
}

async function eventTypes(dir: string): Promise<string[]> {
  const raw = await readFile(join(dir, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { event: { type: string } }).event.type);
}

function assertSubsequence(haystack: string[], needle: string[]): void {
  let i = 0;
  for (const item of haystack) if (item === needle[i]) i++;
  assert.equal(
    i,
    needle.length,
    `expected ${JSON.stringify(needle)} as a subsequence of ${JSON.stringify(haystack)}`,
  );
}

test("ingest --auto-approve runs the full loop: blocks -> Jev miniloop -> gate -> graph", async () => {
  const jev = await startMockJev();
  try {
    const { dir, file } = await makeNovel();
    const env = {
      ...process.env,
      TYPESAFE_API_KEY: FAKE_KEY,
      JEV_ENDPOINT: jev.url,
      NOVEL_SECRETS_DIR: join(dir, "secrets"),
    };
    const result = await ingestNovel(dir, file, { autoApprove: true, env });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.mergedBlocks, ["b0001", "b0002"]);
    assert.equal(result.stoppedAt, null);
    assert.ok(result.graph, "graph counts returned after merges");

    // The real JevClient was consulted through the wire mock...
    assert.ok(jev.seenKeys.some((k) => k.startsWith("boundary:")), "scene-boundary questions asked");
    assert.ok(jev.seenKeys.some((k) => k.startsWith("kind:")), "dialogue questions asked");
    // ...and the seeded entity reached the presence patch, which only
    // happens when the cumulative registry is actually loaded per block
    // (the old code hardcoded an empty registry).
    assert.ok(
      jev.seenKeys.includes("present:char_000001"),
      "presence asked about the seeded entity from the bundle registry",
    );

    const types = await eventTypes(dir);
    assertSubsequence(types, [
      "block.started",
      "sectioned",
      "changeset.pending",
      "changeset.approved",
      "changeset.applied",
      "changeset.merged",
      "block.started",
      "graph.rebuilt",
    ]);
    // Exactly one of each gate event per block: saveChangeSet is the
    // single emitter of record (a second emitter anywhere duplicates).
    for (const t of ["changeset.pending", "changeset.approved", "changeset.applied", "changeset.merged"]) {
      assert.equal(
        types.filter((x) => x === t).length,
        2,
        `${t} emitted exactly once per block (2 blocks)`,
      );
    }

    const changesets = await listChangeSets(dir);
    assert.equal(changesets.length, 2);
    assert.ok(changesets.every((c) => c.status === "approved"));
  } finally {
    await jev.close();
  }
});

test("ingest in gate mode stops at the first merge gate with the ChangeSet held", async () => {
  const jev = await startMockJev();
  try {
    const { dir, file } = await makeNovel();
    const env = {
      ...process.env,
      TYPESAFE_API_KEY: FAKE_KEY,
      JEV_ENDPOINT: jev.url,
      NOVEL_SECRETS_DIR: join(dir, "secrets"),
    };
    const result = await ingestNovel(dir, file, { env });
    assert.deepEqual(result.mergedBlocks, []);
    assert.equal(result.stoppedAt, "b0001");
    assert.match(result.stopReason ?? "", /held/i);
    assert.equal(result.graph, null);

    const changesets = await listChangeSets(dir);
    assert.equal(changesets.length, 1);
    assert.equal(changesets[0].status, "held");

    const types = await eventTypes(dir);
    assertSubsequence(types, ["block.started", "sectioned", "changeset.pending", "changeset.held"]);
    assert.equal(types.filter((x) => x === "changeset.pending").length, 1);
    assert.equal(types.filter((x) => x === "changeset.held").length, 1);
    assert.ok(!types.includes("changeset.merged"), "nothing merged behind the gate");
  } finally {
    await jev.close();
  }
});

test("ingest refuses to run without a Jev key and points at jev login", async () => {
  const { dir, file } = await makeNovel();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NOVEL_SECRETS_DIR: join(dir, "empty-secrets"),
  };
  delete env.TYPESAFE_API_KEY;
  delete env.JEV_API_KEY_ENV;
  await assert.rejects(() => ingestNovel(dir, file, { env }), /Jev API key missing/);
});
