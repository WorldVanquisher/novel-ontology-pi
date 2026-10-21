import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { BundleManifest } from "./bundle.js";

/**
 * Bundle export / import — moving the portable ontology bundle in and out.
 *
 * The bundle (DESIGN.md §3) is the source of truth: the novel folder with
 * `source/`, `ontology/` (manifest.json + JSONL), `branches/<id>/` deltas
 * and the `changesets/` audit trail. The Ladybug graph (`graph.lbug`) is a
 * disposable rebuild (`novel graph build`), so it is NEVER exported.
 *
 * Both directions are byte-faithful copies of the bundle files — no
 * parse-and-reserialize — so IDs, evidence, relationships, timelines,
 * branching data and any fields this version does not recognize survive
 * the round-trip untouched.
 *
 * Safety rules:
 * - Nothing is overwritten: an existing export/import target is an error.
 * - Import validates the whole bundle BEFORE writing (manifest shape,
 *   every JSON file parses, every JSONL line parses) and stages into a
 *   temporary sibling directory, renamed into place only once complete —
 *   a failed import leaves no partial target behind.
 * - Secret-shaped files (`.env*`, private keys, credentials) and derived
 *   graph files are excluded from the copy in both directions and are
 *   reported, never silently dropped.
 */

export const SUPPORTED_SCHEMA_VERSION = 1;

/** JSONL files that live in `ontology/` (the graph build reads these). */
export const ONTOLOGY_JSONL = [
  "entities.jsonl",
  "relations.jsonl",
  "events.jsonl",
  "scenes.jsonl",
  "timelines.jsonl",
  "branches.jsonl",
];

export interface ExcludedFile {
  path: string; // path relative to the bundle root, POSIX separators
  reason: string;
}

export interface BundleTransferResult {
  novelId: string;
  title: string;
  schemaVersion: number;
  fileCount: number;
  /** Record counts for the ontology JSONL files that were present. */
  recordCounts: Record<string, number>;
  excluded: ExcludedFile[];
}

interface ValidatedBundle {
  manifest: BundleManifest;
  /** All files under the root (relative POSIX paths), sorted. */
  files: string[];
  recordCounts: Record<string, number>;
}

/** Why a file never travels with a bundle, or null if it is portable. */
export function exclusionReason(relPath: string): string | null {
  const base = basename(relPath).toLowerCase();
  if (base.endsWith(".lbug") || base.endsWith(".lbug.wal")) {
    return "derived Ladybug graph — rebuilt from the bundle with `novel graph build`";
  }
  if (base.startsWith(".env")) return "environment file — may contain API keys";
  if (base.startsWith("id_rsa") || base.startsWith("id_ed25519")) {
    return "private key material";
  }
  if (base.endsWith(".key") || base.endsWith(".pem") || base.endsWith(".p12") || base.endsWith(".pfx")) {
    return "key/certificate material";
  }
  if (base.startsWith("credentials")) return "credentials file";
  return null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(root, full)));
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out.sort();
}

function manifestProblem(m: unknown): string | null {
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    return "manifest is not a JSON object";
  }
  const o = m as Record<string, unknown>;
  if (typeof o.novelId !== "string" || o.novelId.length === 0) {
    return "manifest.novelId must be a non-empty string";
  }
  if (typeof o.title !== "string") return "manifest.title must be a string";
  if (!Number.isInteger(o.schemaVersion)) {
    return "manifest.schemaVersion must be an integer";
  }
  if (o.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return `unsupported manifest.schemaVersion ${String(o.schemaVersion)} — this CLI supports schema v${SUPPORTED_SCHEMA_VERSION}`;
  }
  if (
    !Array.isArray(o.sourceLanguages) ||
    o.sourceLanguages.some((l) => typeof l !== "string")
  ) {
    return "manifest.sourceLanguages must be an array of strings";
  }
  if (typeof o.decisionModel !== "string") {
    return "manifest.decisionModel must be a string";
  }
  if (
    o.embeddingModel !== undefined &&
    o.embeddingModel !== null &&
    typeof o.embeddingModel !== "string"
  ) {
    return "manifest.embeddingModel must be a string or null";
  }
  if (
    o.embeddingDimension !== undefined &&
    o.embeddingDimension !== null &&
    typeof o.embeddingDimension !== "number"
  ) {
    return "manifest.embeddingDimension must be a number or null";
  }
  return null;
}

/**
 * Structural validation of a bundle directory: manifest present and
 * well-formed, every portable `.json` file parses, every line of every
 * portable `.jsonl` file parses. Throws a specific error naming the file
 * (and the line, for JSONL) on the first problem. Read-only.
 */
export async function validateBundleDir(root: string): Promise<ValidatedBundle> {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`bundle directory not found: ${root}`);
  }
  const manifestPath = join(root, "ontology", "manifest.json");
  const rawManifest = await readFile(manifestPath, "utf8").catch(() => null);
  if (rawManifest === null) {
    throw new Error(
      `bundle manifest not found: ${manifestPath} — expected a novel bundle directory (ontology/manifest.json)`,
    );
  }
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(rawManifest) as BundleManifest;
  } catch (err) {
    throw new Error(`invalid bundle manifest ${manifestPath}: ${String(err)}`);
  }
  const problem = manifestProblem(manifest);
  if (problem) {
    throw new Error(`invalid bundle manifest ${manifestPath}: ${problem}`);
  }

  const files = await walkFiles(root);
  const recordCounts: Record<string, number> = {};
  for (const rel of files) {
    if (exclusionReason(rel) !== null) continue;
    if (rel.endsWith(".jsonl")) {
      const raw = await readFile(join(root, rel), "utf8");
      const lines = raw.split("\n");
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().length === 0) continue;
        try {
          JSON.parse(lines[i]);
        } catch (err) {
          throw new Error(
            `corrupt JSONL in bundle: ${rel} line ${i + 1}: ${String(err)}`,
          );
        }
        count++;
      }
      if (rel.startsWith("ontology/")) {
        recordCounts[basename(rel, ".jsonl")] = count;
      }
    } else if (rel.endsWith(".json")) {
      const raw = await readFile(join(root, rel), "utf8");
      try {
        JSON.parse(raw);
      } catch (err) {
        throw new Error(`invalid JSON in bundle: ${rel}: ${String(err)}`);
      }
    }
  }
  return { manifest, files, recordCounts };
}

/**
 * Copy `files` from srcRoot into a staging sibling of destDir, verify the
 * copy (file sizes), then rename into place. destDir must not exist; on
 * any failure the staging directory is removed and destDir is untouched.
 */
async function stageAndMove(
  srcRoot: string,
  files: string[],
  destDir: string,
  destLabel: string,
): Promise<void> {
  if (await pathExists(destDir)) {
    throw new Error(
      `${destLabel} already exists: ${destDir} — refusing to overwrite (remove it first or choose a different path)`,
    );
  }
  const parent = dirname(destDir);
  await mkdir(parent, { recursive: true });
  const staging = join(
    parent,
    `.${basename(destDir)}.staging-${process.pid}-${Date.now()}`,
  );
  try {
    for (const rel of files) {
      const to = join(staging, rel);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(join(srcRoot, rel), to);
    }
    for (const rel of files) {
      const [a, b] = await Promise.all([
        stat(join(srcRoot, rel)),
        stat(join(staging, rel)),
      ]);
      if (a.size !== b.size) {
        throw new Error(`copy verification failed for ${rel}: size mismatch`);
      }
    }
    if (await pathExists(destDir)) {
      throw new Error(
        `${destLabel} already exists: ${destDir} — refusing to overwrite`,
      );
    }
    await rename(staging, destDir);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

function portableFiles(validated: ValidatedBundle): {
  copy: string[];
  excluded: ExcludedFile[];
} {
  const copy: string[] = [];
  const excluded: ExcludedFile[] = [];
  for (const rel of validated.files) {
    const reason = exclusionReason(rel);
    if (reason) excluded.push({ path: rel, reason });
    else copy.push(rel);
  }
  return { copy, excluded };
}

function assertNotNested(a: string, b: string, what: string): void {
  const rel = relative(a, b);
  const inside =
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
  if (inside) {
    throw new Error(`${what}: target ${b} must not be inside source ${a}`);
  }
}

/** Export the bundle at `novelDir` to a new directory `outDir`. */
export async function exportBundle(
  novelDir: string,
  outDir: string,
): Promise<BundleTransferResult & { novelDir: string; outDir: string }> {
  const validated = await validateBundleDir(novelDir);
  assertNotNested(novelDir, outDir, "bundle export");
  const { copy, excluded } = portableFiles(validated);
  await stageAndMove(novelDir, copy, outDir, "export target");
  return {
    novelId: validated.manifest.novelId,
    title: validated.manifest.title,
    schemaVersion: validated.manifest.schemaVersion,
    fileCount: copy.length,
    recordCounts: validated.recordCounts,
    excluded,
    novelDir,
    outDir,
  };
}

/** Import the bundle at `bundleDir` into a new novel directory `targetDir`. */
export async function importBundle(
  bundleDir: string,
  targetDir: string,
): Promise<BundleTransferResult & { bundleDir: string; targetDir: string }> {
  // Validate everything before a single byte is written anywhere.
  const validated = await validateBundleDir(bundleDir);
  assertNotNested(bundleDir, targetDir, "bundle import");
  const { copy, excluded } = portableFiles(validated);
  await stageAndMove(bundleDir, copy, targetDir, "import target");
  return {
    novelId: validated.manifest.novelId,
    title: validated.manifest.title,
    schemaVersion: validated.manifest.schemaVersion,
    fileCount: copy.length,
    recordCounts: validated.recordCounts,
    excluded,
    bundleDir,
    targetDir,
  };
}
