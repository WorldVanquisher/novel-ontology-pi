/**
 * Durable secret store — provider keys the environment does not carry.
 *
 * The resolution order mimics open-source Jev integrations (Codewhale's
 * System One client resolves its TypeSafe key the same way):
 *   1. TYPESAFE_API_KEY in the environment
 *   2. this durable secret store
 *   3. indirection: JEV_API_KEY_ENV names another environment variable
 *
 * The store is one JSON file in a user-level directory
 * ($NOVEL_SECRETS_DIR, else $XDG_CONFIG_HOME/novel-ontology, else
 * ~/.config/novel-ontology). The directory is created mode 0700 and
 * the file mode 0600, and both are re-chmodded on every write.
 *
 * Values are write-only from the CLI's perspective: no command prints
 * a stored key, `novel jev status` reports the SOURCE only, and bundle
 * export never includes this directory (it lives outside the novel).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const JEV_SECRET_NAME = "typesafe";
export const JEV_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_KEY_ENV_INDIRECTION = "JEV_API_KEY_ENV";

export type JevKeySource = "env" | "store" | "env-indirect";

export interface ResolvedKey {
  key: string;
  source: JevKeySource;
}

const nonEmpty = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

export function secretStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonEmpty(env.NOVEL_SECRETS_DIR);
  if (override) return override;
  const xdg = nonEmpty(env.XDG_CONFIG_HOME);
  const base = xdg ?? join(homedir(), ".config");
  return join(base, "novel-ontology");
}

export function secretStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(secretStoreDir(env), "secrets.json");
}

type SecretStore = Record<string, string>;

function readStore(env: NodeJS.ProcessEnv): SecretStore {
  const path = secretStorePath(env);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const store: SecretStore = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) store[name] = value;
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(env: NodeJS.ProcessEnv, store: SecretStore): void {
  const dir = secretStoreDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = secretStorePath(env);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function getStoredSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return nonEmpty(readStore(env)[name]);
}

export function setStoredSecret(
  name: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const key = nonEmpty(value);
  if (!key) throw new Error(`Refusing to store an empty secret for "${name}".`);
  const store = readStore(env);
  store[name] = key;
  writeStore(env, store);
}

export function deleteStoredSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const store = readStore(env);
  if (!(name in store)) return false;
  delete store[name];
  if (Object.keys(store).length === 0) {
    rmSync(secretStorePath(env), { force: true });
  } else {
    writeStore(env, store);
  }
  return true;
}

/**
 * Resolve the Jev key without ever printing it: environment first,
 * then the durable store, then the JEV_API_KEY_ENV indirection.
 */
export function resolveJevKey(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedKey | null {
  const fromEnv = nonEmpty(env[JEV_KEY_ENV]);
  if (fromEnv) return { key: fromEnv, source: "env" };
  const fromStore = getStoredSecret(JEV_SECRET_NAME, env);
  if (fromStore) return { key: fromStore, source: "store" };
  const indirectName = nonEmpty(env[JEV_KEY_ENV_INDIRECTION]);
  if (indirectName) {
    const indirect = nonEmpty(env[indirectName]);
    if (indirect) return { key: indirect, source: "env-indirect" };
  }
  return null;
}
