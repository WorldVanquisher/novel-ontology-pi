import { copyFile, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { cutBlocks } from "../text/blocks.js";
import { BlockProcessor } from "../processing/blockProcessor.js";
import { BundleStore } from "../connectors/bundle.js";
import { jevFromEnv } from "../connectors/jev.js";
import { workModelFromEnv } from "../connectors/workModel.js";
import { resolveJevKey } from "../connectors/secrets.js";
import { EventLog } from "../events/log.js";
import {
  loadCorrections,
  pinsForBlock,
} from "../maintenance/corrections.js";
import { appendAudit } from "../maintenance/fixes.js";
import { changesetDir, loadChangeSet } from "../merge/changesetStore.js";
import type { Entity } from "../ontology/types.js";

/**
 * `novel recall <novel-dir> <blockId>` — the recall protocol
 * (sector 09): re-run ONE block from the workspace's stored source,
 * with the reviewing agent's pinned corrections honored by the
 * miniloop, producing a FRESH held ChangeSet for re-review. The
 * superseded ChangeSet is kept beside it for audit.
 */
export async function runRecall(
  novelDir: string,
  blockId: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
) {
  const env = opts.env ?? process.env;
  const ontologyDir = join(novelDir, "ontology");
  try {
    await stat(join(ontologyDir, "manifest.json"));
  } catch {
    throw new Error(
      `No novel workspace manifest at ${join(ontologyDir, "manifest.json")}. Run \`novel init ${novelDir}\` first.`,
    );
  }
  if (!resolveJevKey(env)?.key) {
    throw new Error(
      "Jev API key missing for the recall re-run. Run `novel jev login`, set TYPESAFE_API_KEY, or set JEV_API_KEY_ENV to the name of an env var that holds it.",
    );
  }

  const sourceDir = join(novelDir, "source");
  let sourceFiles: string[] = [];
  try {
    sourceFiles = await readdir(sourceDir);
  } catch {
    sourceFiles = [];
  }
  if (sourceFiles.length === 0) {
    throw new Error(
      `No stored source in ${sourceDir} — recall needs the source copy that ingest saves. Re-run \`novel ingest\` once to populate it.`,
    );
  }
  let block: { id: string; text: string; chapterIndex: number } | null = null;
  for (const f of sourceFiles) {
    const text = await readFile(join(sourceDir, f), "utf8");
    const found = cutBlocks(text).find((b) => b.id === blockId);
    if (found) {
      block = found;
      break;
    }
  }
  if (!block) {
    throw new Error(
      `Block ${blockId} not found in the stored source (${sourceFiles.join(", ")}). Block ids come from the default cutter; a custom --block-size ingest may number differently.`,
    );
  }

  const corrections = await loadCorrections(novelDir);
  const pins = pinsForBlock(corrections, blockId);

  // Preserve the superseded changeset for audit before it is replaced.
  const csPath = join(changesetDir(novelDir), `cs_${blockId}.json`);
  let supersededKept = false;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(csPath, join(changesetDir(novelDir), `cs_${blockId}.superseded-${stamp}.json`));
    supersededKept = true;
  } catch {
    supersededKept = false;
  }

  const bundle = new BundleStore(ontologyDir);
  const log = new EventLog(novelDir);
  const loadKnownEntities = async (): Promise<Entity[]> => {
    const rows = await bundle.loadFile<Entity>("entities.jsonl");
    const byId = new Map<string, Entity>();
    for (const e of rows) byId.set(e.id, e);
    return [...byId.values()];
  };
  const loadCounts = async (): Promise<{ events: number; scenes: number }> => {
    const events = await bundle.loadFile<{ id: string }>("events.jsonl");
    const scenes = await bundle.loadFile<{ id: string }>("scenes.jsonl");
    return {
      events: new Set(events.map((e) => e.id)).size,
      scenes: new Set(scenes.map((s) => s.id)).size,
    };
  };
  let workModel = undefined;
  try {
    workModel = workModelFromEnv(env);
  } catch {
    workModel = undefined;
  }

  const processor = new BlockProcessor(bundle, jevFromEnv(env), async () => "held", {
    novelDir,
    emit: log.emit,
    loadKnownEntities,
    loadCounts,
    loadCorrections: () => loadCorrections(novelDir),
    workModel,
  });
  await processor.processNovel([
    { blockId: block.id, text: block.text, chapterIndex: block.chapterIndex },
  ]);
  await appendAudit(novelDir, "recall", {
    blockId,
    pins: [...pins.keys()],
    supersededKept,
  });

  const cs = await loadChangeSet(novelDir, `cs_${blockId}`);
  return {
    status: "ok",
    novelDir,
    blockId,
    changesetId: `cs_${blockId}`,
    pinsHonored: Object.keys(cs?.reviewNotes ?? {}).filter((k) =>
      k.startsWith("recall:pin:"),
    ).length,
    proposals: cs?.proposals.length ?? 0,
    supersededKept,
  };
}
