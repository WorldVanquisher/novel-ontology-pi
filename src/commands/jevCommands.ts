/**
 * `novel jev login|status|logout|ping` — the CLI's own secure key
 * system for the decision model (Jev / TypeSafe).
 *
 * login stores the key in the durable secret store (user-level
 * directory, file mode 0600 — see src/connectors/secrets.ts) after a
 * hidden prompt: the key is never echoed, never taken from a command
 * argument, and never printed by any command. `--from-env` copies the
 * current TYPESAFE_API_KEY into the store instead of prompting.
 *
 * status reports the key's SOURCE only (env / store / env-indirect /
 * missing), following the `novel config` precedent. logout removes
 * the stored copy (an environment variable, if set, is unaffected).
 * ping spends one tiny live decision to prove the resolved key works.
 */
import { loadConfig } from "../config.js";
import { jevFromEnv } from "../connectors/jev.js";
import {
  JEV_KEY_ENV,
  JEV_SECRET_NAME,
  deleteStoredSecret,
  resolveJevKey,
  secretStorePath,
  setStoredSecret,
  type JevKeySource,
} from "../connectors/secrets.js";

export interface JevStatusResult {
  status: "ok";
  provider: "jev";
  endpoint: string;
  model: string;
  apiKey: "configured" | "missing";
  apiKeySource: JevKeySource | null;
  storePath: string;
}

export function jevStatus(env: NodeJS.ProcessEnv = process.env): JevStatusResult {
  const resolved = resolveJevKey(env);
  const cfg = loadConfig(env, {
    jevKeySource:
      resolved && resolved.source !== "env" ? resolved.source : null,
  });
  return {
    status: "ok",
    provider: "jev",
    endpoint: cfg.decisionModel.endpoint,
    model: cfg.decisionModel.model,
    apiKey: resolved ? "configured" : "missing",
    apiKeySource: resolved?.source ?? null,
    storePath: secretStorePath(env),
  };
}

export interface JevLoginResult {
  status: "ok";
  stored: typeof JEV_SECRET_NAME;
  source: "prompt" | "env";
  storePath: string;
}

export async function jevLogin(
  env: NodeJS.ProcessEnv = process.env,
  opts: { fromEnv?: boolean; prompt?: () => Promise<string> } = {},
): Promise<JevLoginResult> {
  if (opts.fromEnv) {
    const key = env[JEV_KEY_ENV]?.trim();
    if (!key) {
      throw new Error(
        `novel jev login --from-env: ${JEV_KEY_ENV} is not set in the environment.`,
      );
    }
    setStoredSecret(JEV_SECRET_NAME, key, env);
    return {
      status: "ok",
      stored: JEV_SECRET_NAME,
      source: "env",
      storePath: secretStorePath(env),
    };
  }
  const read = opts.prompt ?? promptHidden;
  const key = (await read()).trim();
  if (!key) throw new Error("novel jev login: no key entered; nothing stored.");
  setStoredSecret(JEV_SECRET_NAME, key, env);
  return {
    status: "ok",
    stored: JEV_SECRET_NAME,
    source: "prompt",
    storePath: secretStorePath(env),
  };
}

export interface JevLogoutResult {
  status: "ok";
  removed: boolean;
}

export function jevLogout(env: NodeJS.ProcessEnv = process.env): JevLogoutResult {
  return { status: "ok", removed: deleteStoredSecret(JEV_SECRET_NAME, env) };
}

export interface JevPingResult {
  status: "ok";
  provider: "jev";
  model: string;
  endpoint: string;
  apiKeySource: JevKeySource;
  latencyMs: number;
  question: string;
  answer: number | string;
}

/** One tiny live decision: proves reachability, auth, and the wire format. */
export async function jevPing(
  env: NodeJS.ProcessEnv = process.env,
): Promise<JevPingResult> {
  const resolved = resolveJevKey(env);
  if (!resolved) {
    throw new Error(
      "Jev API key missing. Run `novel jev login` to store it securely, or set TYPESAFE_API_KEY.",
    );
  }
  const cfg = loadConfig(env);
  const client = jevFromEnv(env);
  const started = Date.now();
  const [answer] = await client.decide(
    "「等一下！」她放下终端，转身追了出去。",
    [
      {
        key: "contains_dialogue",
        primitive: "noul",
        instructions: "Does this passage contain spoken dialogue?",
      },
    ],
  );
  return {
    status: "ok",
    provider: "jev",
    model: client.modelId,
    endpoint: cfg.decisionModel.endpoint,
    apiKeySource: resolved.source,
    latencyMs: Date.now() - started,
    question: "contains_dialogue",
    answer: answer?.value ?? 0,
  };
}

/**
 * Read a line with terminal echo disabled: raw mode means the key is
 * never written to the screen, not even masked.
 */
function promptHidden(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Piped input: read the first line as-is (scripts, tests).
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => {
        buf += chunk;
      });
      stdin.on("end", () => resolvePromise(buf.split(/\r?\n/)[0] ?? ""));
      stdin.on("error", rejectPromise);
      stdin.resume();
      return;
    }
    process.stdout.write("TypeSafe (Jev) API key (input hidden): ");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\n" || c === "\r" || c === "") {
          cleanup();
          process.stdout.write("\n");
          resolvePromise(value);
          return;
        }
        if (c === "") {
          cleanup();
          rejectPromise(new Error("novel jev login: aborted."));
          return;
        }
        if (c === "" || c === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += c;
      }
    };
    stdin.on("data", onData);
  });
}
