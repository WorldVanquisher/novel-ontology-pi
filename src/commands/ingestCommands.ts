import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { cutBlocks } from "../text/blocks.js";
import { BlockProcessor, type ReviewDecision } from "../processing/blockProcessor.js";
import { BundleStore } from "../connectors/bundle.js";
import { buildGraphFromBundle } from "../connectors/ladybug.js";
import { jevFromEnv } from "../connectors/jev.js";
import { workModelFromEnv, type HttpWorkModel } from "../connectors/workModel.js";
import { loadCorrections } from "../maintenance/corrections.js";
import { resolveJevKey } from "../connectors/secrets.js";
import { EventLog } from "../events/log.js";
import type { Entity } from "../ontology/types.js";

export interface IngestOptions {
  /** Approve every ChangeSet at the merge gate (smoke runs, trusted batches). */
  autoApprove?: boolean;
  /** Stop after this many blocks. */
  maxBlocks?: number;
  /** Target block size in chars for the block cutter. */
  blockSize?: number;
  /** Force the extraction step off even when a work LLM is configured. */
  noExtract?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * `novel ingest <novel-dir> <file>` — the full processing loop for one
 * text file: cut blocks -> section -> System 1 miniloop (live Jev) ->
 * ChangeSets -> merge gate -> bundle + rebuilt graph.
 *
 * Review modes:
 *  - default: the FIRST block's ChangeSet is saved and the run stops at
 *    the gate ("held"). Review it with `novel changeset show`, then
 *    `novel changeset approve` to apply it, and re-run ingest to roll on.
 *    This is the main-agent workflow: the agent reads each ChangeSet and
 *    only then lets the run continue.
 *  - --auto-approve: every ChangeSet is approved and applied in-process.
 *    For smoke tests and trusted batches; the gate still exists — the
 *    reviewer is just the flag.
 *
 * The known-entity registry is the bundle itself: entities.jsonl is
 * re-read (last write wins) before every block, so names merged by
 * earlier blocks or earlier runs are known to later ones.
 */
export async function ingestNovel(
  novelDir: string,
  file: string,
  opts: IngestOptions = {},
) {
  const env = opts.env ?? process.env;
  const ontologyDir = join(novelDir, "ontology");
  try {
    await stat(join(ontologyDir, "manifest.json"));
  } catch {
    throw new Error(
      `${novelDir} is not a novel workspace (missing ontology/manifest.json). Run \`novel init ${novelDir}\` first.`,
    );
  }
  if (!resolveJevKey(env)) {
    throw new Error(
      "Jev API key missing. Run `novel jev login` to store it securely, or set TYPESAFE_API_KEY.",
    );
  }

  const text = await readFile(file, "utf8");
  // Keep a copy of the source inside the workspace: the recall
  // protocol (sector 09) re-runs a single block from it, in a later
  // session, without the original file at hand.
  const sourceDir = join(novelDir, "source");
  await mkdir(sourceDir, { recursive: true });
  await copyFile(file, join(sourceDir, basename(file)));
  const allBlocks = cutBlocks(text, opts.blockSize);
  const blocks = opts.maxBlocks ? allBlocks.slice(0, opts.maxBlocks) : allBlocks;

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

  // Extraction (sector 08) runs when a work LLM is configured and not
  // explicitly disabled. Its absence is reported, never silent.
  let workModel: HttpWorkModel | null = null;
  if (!opts.noExtract) {
    try {
      workModel = workModelFromEnv(env);
    } catch {
      workModel = null;
    }
  }

  const review = async (): Promise<ReviewDecision> =>
    opts.autoApprove ? "approved" : "held";

  const processor = new BlockProcessor(bundle, jevFromEnv(env), review, {
    novelDir,
    emit: log.emit,
    loadKnownEntities,
    loadCounts,
    loadCorrections: () => loadCorrections(novelDir),
    workModel: workModel ?? undefined,
  });

  const result = await processor.processNovel(
    blocks.map((b) => ({ blockId: b.id, text: b.text, chapterIndex: b.chapterIndex })),
  );

  let graph: Awaited<ReturnType<typeof buildGraphFromBundle>> | null = null;
  if (result.mergedBlocks.length > 0) {
    graph = await buildGraphFromBundle(
      ontologyDir,
      join(ontologyDir, "graph.lbug"),
      log.emit,
    );
  }

  return {
    status: "ok",
    novelDir,
    file,
    reviewMode: opts.autoApprove ? "auto-approve" : "gate",
    extraction: workModel ? "live" : "off",
    workModel: workModel?.modelId ?? null,
    blocksTotal: blocks.length,
    blocksInFile: allBlocks.length,
    mergedBlocks: result.mergedBlocks,
    stoppedAt: result.stoppedAt,
    stopReason: result.stopReason,
    graph,
  };
}
