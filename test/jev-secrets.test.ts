/**
 * The Jev secure key system + live client wire format.
 *
 * Key resolution order (mimicking open-source Jev integrations):
 * env -> durable secret store -> JEV_API_KEY_ENV indirection.
 * Nothing here leaves 127.0.0.1 except the store round-trips, which
 * stay inside a per-test temporary NOVEL_SECRETS_DIR. The fake key
 * must appear in the store file (that is its job) and NOWHERE in any
 * command output (that is the system's job).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { JevClient } from "../src/connectors/jev.js";
import {
  deleteStoredSecret,
  getStoredSecret,
  resolveJevKey,
  secretStorePath,
  setStoredSecret,
} from "../src/connectors/secrets.js";
import { jevStatus } from "../src/commands/jevCommands.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const FAKE_KEY = ["sk", "test", "fake", "key", "0000000000"].join("-");

function tempEnv(t: TestContext): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "novel-secrets-"));
  t.after(() => {});
  return { NOVEL_SECRETS_DIR: dir };
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

test("store round-trips with owner-only permissions", (t) => {
  const env = tempEnv(t);
  setStoredSecret("typesafe", FAKE_KEY, env);
  assert.equal(getStoredSecret("typesafe", env), FAKE_KEY);
  const path = secretStorePath(env);
  assert.ok(existsSync(path));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(env.NOVEL_SECRETS_DIR!).mode & 0o777, 0o700);
  assert.ok(readFileSync(path, "utf8").includes(FAKE_KEY));
  assert.equal(deleteStoredSecret("typesafe", env), true);
  assert.equal(getStoredSecret("typesafe", env), null);
  assert.equal(deleteStoredSecret("typesafe", env), false);
});

test("resolution order: env beats store beats indirection; blanks are ignored", (t) => {
  const env = tempEnv(t);
  setStoredSecret("typesafe", "store-key", env);
  env.JEV_API_KEY_ENV = "MY_JEV_KEY";
  env.MY_JEV_KEY = "indirect-key";
  assert.deepEqual(resolveJevKey(env), { key: "store-key", source: "store" });
  env.TYPESAFE_API_KEY = "env-key";
  assert.deepEqual(resolveJevKey(env), { key: "env-key", source: "env" });
  delete env.TYPESAFE_API_KEY;
  deleteStoredSecret("typesafe", env);
  assert.deepEqual(resolveJevKey(env), { key: "indirect-key", source: "env-indirect" });
  env.MY_JEV_KEY = "   ";
  assert.equal(resolveJevKey(env), null);
});

test("loadConfig reports the store source without the value", (t) => {
  const env = tempEnv(t);
  setStoredSecret("typesafe", FAKE_KEY, env);
  const resolved = resolveJevKey(env);
  const cfg = loadConfig(env, {
    jevKeySource: resolved && resolved.source !== "env" ? resolved.source : null,
  });
  assert.equal(cfg.decisionModel.apiKey, "configured");
  assert.equal(cfg.decisionModel.apiKeySource, "store");
  assert.ok(!cfg.missingForLiveIngest.includes("TYPESAFE_API_KEY"));
  assert.ok(!JSON.stringify(cfg).includes(FAKE_KEY));
});

test("jev status reports the source and never the key", async (t) => {
  const env = tempEnv(t);
  setStoredSecret("typesafe", FAKE_KEY, env);
  const status = jevStatus(env);
  assert.equal(status.apiKey, "configured");
  assert.equal(status.apiKeySource, "store");
  assert.ok(!JSON.stringify(status).includes(FAKE_KEY));
  const { code, stdout, stderr } = await runCli(["jev", "status"], env);
  assert.equal(code, 0);
  assert.ok(stdout.includes('"store"'));
  assert.ok(!stdout.includes(FAKE_KEY) && !stderr.includes(FAKE_KEY));
});

test("jev login --from-env stores the key and prints no part of it", async (t) => {
  const env = tempEnv(t);
  env.TYPESAFE_API_KEY = FAKE_KEY;
  const { code, stdout, stderr } = await runCli(["jev", "login", "--from-env"], env);
  assert.equal(code, 0);
  assert.ok(!stdout.includes(FAKE_KEY) && !stderr.includes(FAKE_KEY));
  // Read back through a clean env: only the store can provide it now.
  assert.equal(getStoredSecret("typesafe", { NOVEL_SECRETS_DIR: env.NOVEL_SECRETS_DIR }), FAKE_KEY);
  const out = await runCli(["jev", "logout"], { NOVEL_SECRETS_DIR: env.NOVEL_SECRETS_DIR });
  assert.equal(out.code, 0);
  assert.equal(getStoredSecret("typesafe", { NOVEL_SECRETS_DIR: env.NOVEL_SECRETS_DIR }), null);
});

interface JevRequest {
  authorization?: string;
  body: Record<string, unknown>;
}

async function startJevMock(
  t: TestContext,
  handler: (req: JevRequest, n: number) => { status: number; body: unknown },
): Promise<{ endpoint: string; requests: JevRequest[] }> {
  const requests: JevRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const parsed: JevRequest = {
        authorization: req.headers["authorization"],
        body: raw ? JSON.parse(raw) : {},
      };
      requests.push(parsed);
      const out = handler(parsed, requests.length);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return { endpoint: `http://127.0.0.1:${addr.port}/v1/systemone`, requests };
}

test("JevClient speaks the real wire format and maps answers back", async (t) => {
  const { endpoint, requests } = await startJevMock(t, () => ({
    status: 200,
    body: {
      model: "jev-1.13.0",
      answers: {
        is_dialogue: { type: "noul", noul: 0.93 },
        speaker: {
          type: "choice",
          choice: "美琴",
          confidence: 0.81,
          probabilities: { "美琴": 0.81, "黒子": 0.19 },
        },
      },
      usage: { input_tokens: 120, output_tokens: 9 },
    },
  }));
  const client = new JevClient({ apiKey: FAKE_KEY, endpoint, model: "jev-1.13.0" });
  const answers = await client.decide("state text", [
    { key: "is_dialogue", primitive: "noul", instructions: "Is it dialogue?" },
    {
      key: "speaker",
      primitive: "choice",
      instructions: "Who speaks?",
      options: ["美琴", "黒子"],
    },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${FAKE_KEY}`);
  const wire = requests[0].body.questions as Record<string, Record<string, unknown>>;
  assert.equal(wire.is_dialogue.type, "noul");
  assert.equal(wire.speaker.type, "choice");
  assert.deepEqual(wire.speaker.criteria, { "美琴": "美琴", "黒子": "黒子" });
  assert.deepEqual(answers, [
    { key: "is_dialogue", value: 0.93 },
    {
      key: "speaker",
      value: "美琴",
      distribution: { "美琴": 0.81, "黒子": 0.19 },
      confidence: 0.81,
    },
  ]);
});

test("JevClient retries a 529 once, then succeeds; a 401 fails at once", async (t) => {
  let n = 0;
  const flaky = await startJevMock(t, () => {
    n++;
    return n === 1
      ? { status: 529, body: { error: "overloaded" } }
      : { status: 200, body: { answers: { q: { type: "noul", noul: 0.5 } } } };
  });
  const client = new JevClient({ apiKey: FAKE_KEY, endpoint: flaky.endpoint, model: "jev-1.13.0" });
  const [answer] = await client.decide("s", [
    { key: "q", primitive: "noul", instructions: "?" },
  ]);
  assert.equal(answer.value, 0.5);
  assert.equal(flaky.requests.length, 2);

  const denied = await startJevMock(t, () => ({ status: 401, body: { error: "bad key" } }));
  const deniedClient = new JevClient({ apiKey: "wrong", endpoint: denied.endpoint, model: "jev-1.13.0" });
  await assert.rejects(
    () => deniedClient.decide("s", [{ key: "q", primitive: "noul", instructions: "?" }]),
    /401/,
  );
  assert.equal(denied.requests.length, 1);
});
