import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { HttpWorkModel } from "../src/connectors/workModel.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const FAKE_KEY = "sk-test-fake-key-value";

interface MockRequest {
  url: string | undefined;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

type Handler = (
  req: MockRequest,
  n: number,
) => { status: number; body: unknown; delayMs?: number };

/** A loopback-only OpenAI-compatible mock. Tests never leave 127.0.0.1. */
async function startMock(
  t: TestContext,
  handler: Handler,
): Promise<{ baseUrl: string; requests: MockRequest[] }> {
  const requests: MockRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    res.on("error", () => {}); // a client may abort (timeout test) mid-reply
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const parsed: MockRequest = {
        url: req.url,
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : {},
      };
      requests.push(parsed);
      const out = handler(parsed, requests.length);
      const send = () => {
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.body));
      };
      if (out.delayMs) setTimeout(send, out.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return { baseUrl: `http://127.0.0.1:${addr.port}/v1`, requests };
}

function completion(content: string, withUsage = true) {
  return {
    status: 200,
    body: {
      model: "mock-model",
      choices: [{ message: { role: "assistant", content } }],
      ...(withUsage
        ? { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }
        : {}),
    },
  };
}

const okHandler: Handler = (req) =>
  completion(
    (req.body as { response_format?: unknown }).response_format
      ? '{"status":"ok"}'
      : "pong",
  );

function client(baseUrl: string, extra: object = {}): HttpWorkModel {
  return new HttpWorkModel({
    baseUrl,
    apiKey: FAKE_KEY,
    model: "mock-model",
    sleep: async () => {},
    ...extra,
  });
}

test("work-llm config: baseUrl defaults per provider and honors WORK_LLM_BASE_URL", () => {
  assert.equal(
    loadConfig({}).workLlm.baseUrl,
    "https://api.deepseek.com/v1",
  );
  assert.equal(
    loadConfig({ WORK_LLM_PROVIDER: "openai" }).workLlm.baseUrl,
    "https://api.openai.com/v1",
  );
  assert.equal(
    loadConfig({ WORK_LLM_BASE_URL: "http://127.0.0.1:9/v1" }).workLlm
      .baseUrl,
    "http://127.0.0.1:9/v1",
  );
  assert.equal(
    loadConfig({ WORK_LLM_PROVIDER: "custom-thing" }).workLlm.baseUrl,
    null,
  );
});

test("work model: generate returns content and reports usage + latency", async (t) => {
  const mock = await startMock(t, okHandler);
  const model = client(mock.baseUrl);
  const r = await model.generateWithInfo({
    system: "sys",
    prompt: "ping",
    maxTokens: 16,
  });
  assert.equal(r.text, "pong");
  assert.equal(r.model, "mock-model");
  assert.deepEqual(r.usage, {
    promptTokens: 3,
    completionTokens: 1,
    totalTokens: 4,
  });
  assert.equal(typeof r.latencyMs, "number");
  assert.equal(r.attempts, 1);
  assert.equal(await model.generate({ system: "s", prompt: "p" }), "pong");
  // Request shape: chat completions against the configured base URL.
  const sent = mock.requests[0];
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(sent.body.model, "mock-model");
  assert.deepEqual(sent.body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "ping" },
  ]);
  assert.equal(sent.body.max_tokens, 16);
  assert.equal(sent.body.response_format, undefined);
});

test("work model: jsonSchema asks for JSON mode; missing usage maps to nulls", async (t) => {
  const mock = await startMock(t, (req) =>
    completion('{"status":"ok"}', false),
  );
  const r = await client(mock.baseUrl).generateWithInfo({
    system: "s",
    prompt: "p",
    jsonSchema: { type: "object" },
  });
  assert.equal(r.text, '{"status":"ok"}');
  assert.deepEqual(mock.requests[0].body.response_format, {
    type: "json_object",
  });
  assert.deepEqual(r.usage, {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
  });
});

test("work model: a 500 is retried and the retry can succeed", async (t) => {
  const mock = await startMock(t, (_req, n) =>
    n === 1
      ? { status: 500, body: { error: "boom" } }
      : completion("pong"),
  );
  const r = await client(mock.baseUrl).generateWithInfo({
    system: "s",
    prompt: "p",
  });
  assert.equal(r.text, "pong");
  assert.equal(r.attempts, 2);
  assert.equal(mock.requests.length, 2);
});

test("work model: persistent 500 fails after the retry budget; 400 is never retried", async (t) => {
  const m500 = await startMock(t, () => ({
    status: 500,
    body: { error: "down" },
  }));
  await assert.rejects(
    client(m500.baseUrl).generate({ system: "s", prompt: "p" }),
    /failed after 3 attempts: Work LLM request failed: 500/,
  );
  assert.equal(m500.requests.length, 3);

  const m400 = await startMock(t, () => ({
    status: 400,
    body: { error: "bad request" },
  }));
  await assert.rejects(
    client(m400.baseUrl).generate({ system: "s", prompt: "p" }),
    /Work LLM request failed: 400/,
  );
  assert.equal(m400.requests.length, 1);
});

test("work model: a slow response is cut off by the timeout", async (t) => {
  const mock = await startMock(t, () => ({
    ...completion("pong"),
    delayMs: 400,
  }));
  await assert.rejects(
    client(mock.baseUrl, { timeoutMs: 50 }).generate({
      system: "s",
      prompt: "p",
    }),
    /timed out after 50 ms|failed after 3 attempts/,
  );
  assert.ok(mock.requests.length >= 1);
});

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", rejectPromise);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

test("llm ping/probe via CLI against the mock; the key value never appears", async (t) => {
  const mock = await startMock(t, okHandler);
  const env = {
    WORK_LLM_API_KEY: FAKE_KEY,
    WORK_LLM_BASE_URL: mock.baseUrl,
    WORK_LLM_MODEL: "mock-model",
  };
  const ping = await runCli(["llm", "ping"], env);
  assert.equal(ping.status, 0, ping.stderr);
  const pingOut = JSON.parse(ping.stdout);
  assert.equal(pingOut.status, "ok");
  assert.equal(pingOut.model, "mock-model");
  assert.equal(pingOut.apiKey, "configured");
  assert.equal(pingOut.reply, "pong");
  assert.equal(pingOut.usage.totalTokens, 4);
  assert.equal(typeof pingOut.latencyMs, "number");

  const probe = await runCli(["llm", "probe", "--pretty"], env);
  assert.equal(probe.status, 0, probe.stderr);
  const probeOut = JSON.parse(probe.stdout);
  assert.equal(probeOut.status, "ok");
  assert.equal(probeOut.jsonValid, true);
  assert.equal(probeOut.usage.totalTokens, 4);

  assert.ok(!ping.stdout.includes(FAKE_KEY));
  assert.ok(!probe.stdout.includes(FAKE_KEY));
  assert.ok(!ping.stderr.includes(FAKE_KEY));
});

test("llm ping via CLI without a key fails loudly and calls nothing", async (t) => {
  const mock = await startMock(t, okHandler);
  const r = await runCli(["llm", "ping"], {
    WORK_LLM_API_KEY: "",
    WORK_LLM_BASE_URL: mock.baseUrl,
    WORK_LLM_MODEL: "mock-model",
  });
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr);
  assert.match(err.error, /WORK_LLM_API_KEY is missing/);
  assert.equal(mock.requests.length, 0);

  const bogus = await runCli(["llm", "bogus"], {
    WORK_LLM_API_KEY: FAKE_KEY,
    WORK_LLM_BASE_URL: mock.baseUrl,
  });
  assert.equal(bogus.status, 1);
  assert.match(JSON.parse(bogus.stderr).error, /Usage: novel llm ping\|probe/);
});
