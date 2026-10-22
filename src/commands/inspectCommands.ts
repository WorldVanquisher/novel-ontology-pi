import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BundleManifest } from "../connectors/bundle.js";
import type {
  Branch,
  Entity,
  OntEvent,
  Relation,
  Scene,
} from "../ontology/types.js";
import { listChangeSets } from "../merge/changesetStore.js";
import { cutBlocks, splitChapters } from "../text/blocks.js";

/**
 * `novel inspect <novel-dir>` — corpus diagnostics over a novel bundle.
 *
 * Every number in the report is a plain count or ratio of stored data:
 * manifest fields copied verbatim, JSONL tallies by kind/type/status,
 * coverage tallies (records carrying a field vs not), and integrity
 * tallies (references pointing at ids that do not exist in the bundle,
 * counted — never "fixed"). There are NO quality judgments, thresholds,
 * or semantic checks here: what the numbers mean is the maintainer's
 * call (DESIGN.md §9 tracks threshold questions separately).
 *
 * Data source: the bundle JSONL + manifest only — the bundle is the
 * source of truth and the Ladybug graph is a disposable rebuild of it
 * (see connectors/bundle.ts), so the graph is never opened; the report
 * only notes whether `ontology/graph.lbug` exists. Missing optional
 * files (no source text yet, no branches, no changesets) yield clean
 * zeroes; a corrupt JSONL line is a specific error naming file + line,
 * read with a strict local reader — BundleStore.loadFile's lenient
 * read (it returns [] on any error) is deliberately NOT used here, so
 * diagnostics never silently undercount a damaged bundle.
 */

/** Ratio rounded to 4 decimals; null when the denominator is 0. */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function tally(values: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Tally with keys in sorted order, for stable diffable output. */
function sortedTally(values: Iterable<string>): Record<string, number> {
  const raw = tally(values);
  const out: Record<string, number> = {};
  for (const k of Object.keys(raw).sort()) out[k] = raw[k];
  return out;
}

/**
 * Strict JSONL read for diagnostics: a missing file is an empty list
 * (optional bundle files are legitimately absent), but a line that does
 * not parse is an error naming the file and line.
 */
async function readJsonlStrict<T>(
  path: string,
  rel: string,
): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: T[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    try {
      out.push(JSON.parse(lines[i]) as T);
    } catch (err) {
      throw new Error(
        `corrupt JSONL in bundle: ${rel} line ${i + 1}: ${String(err)}`,
      );
    }
  }
  return out;
}

async function readManifest(
  novelDir: string,
  ontologyDir: string,
): Promise<BundleManifest> {
  const path = join(ontologyDir, "manifest.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `not a novel workspace: ${novelDir} — no ontology/manifest.json (create one with: novel init ${novelDir})`,
      );
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as BundleManifest;
  } catch (err) {
    throw new Error(`invalid bundle manifest ${path}: ${String(err)}`);
  }
}

export interface SourceFileStats {
  name: string;
  bytes: number;
  characters: number;
  chapters: number;
  /** Blocks at the default cutBlocks target size (24k chars). */
  blocks: number;
}

export interface InspectResult {
  novelDir: string;
  manifest: {
    novelId: string;
    title: string;
    schemaVersion: number;
    sourceLanguages: string[];
    decisionModel: string;
    embeddingModel: string | null;
    embeddingDimension: number | null;
    blocksProcessed: number;
  };
  graph: { built: boolean };
  source: {
    files: SourceFileStats[];
    totals: { files: number; bytes: number; characters: number; chapters: number; blocks: number };
  };
  ontology: {
    entities: { total: number; byKind: Record<string, number> };
    relations: { total: number; byType: Record<string, number> };
    events: { total: number; byType: Record<string, number>; byTimeline: Record<string, number> };
    scenes: { total: number; byChapter: Record<string, number> };
    timelines: { total: number };
    branches: { total: number };
  };
  coverage: {
    entities: {
      total: number;
      withNames: number;
      withoutNames: number;
      withCanonicalName: number;
      withoutCanonicalName: number;
    };
    events: {
      total: number;
      withTimelineId: number;
      missingTimelineId: number;
      referencingUnknownTimeline: number;
      withEvidence: number;
      withoutEvidence: number;
      evidenceRatio: number | null;
      withPrimaryActors: number;
      withoutPrimaryActors: number;
    };
    scenes: {
      total: number;
      withLocation: number;
      withoutLocation: number;
      dialogueTurns: number;
      unresolvedTurns: number;
    };
  };
  integrity: {
    /** Id universe = every id stored in entities/events/scenes/timelines/branches. */
    relations: {
      total: number;
      fullyResolved: number;
      danglingFromRefs: number;
      danglingToRefs: number;
    };
    events: {
      unknownPrimaryActorRefs: number;
      unknownAffectedRefs: number;
      unknownTimelineRefs: number;
    };
    scenes: {
      unknownCharacterRefs: number;
      unknownLocationRefs: number;
    };
    branches: {
      unknownParentTimelineRefs: number;
      unknownForkEventRefs: number;
    };
  };
  branches: {
    ontologyRecords: number;
    dirs: { id: string; files: string[] }[];
  };
  changesets: {
    total: number;
    byStatus: Record<string, number>;
    proposalsTotal: number;
  };
}

/** `novel inspect <novel-dir>` — diagnostics over the bundle, as stored. */
export async function inspectNovel(novelDirArg: string): Promise<InspectResult> {
  const novelDir = resolve(novelDirArg);
  const dirStat = await stat(novelDir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error(`novel directory not found: ${novelDirArg}`);
  }
  const ontologyDir = join(novelDir, "ontology");
  const manifest = await readManifest(novelDirArg, ontologyDir);

  const entities = await readJsonlStrict<Entity>(join(ontologyDir, "entities.jsonl"), "ontology/entities.jsonl");
  const relations = await readJsonlStrict<Relation>(join(ontologyDir, "relations.jsonl"), "ontology/relations.jsonl");
  const events = await readJsonlStrict<OntEvent>(join(ontologyDir, "events.jsonl"), "ontology/events.jsonl");
  const scenes = await readJsonlStrict<Scene>(join(ontologyDir, "scenes.jsonl"), "ontology/scenes.jsonl");
  const timelines = await readJsonlStrict<Entity>(join(ontologyDir, "timelines.jsonl"), "ontology/timelines.jsonl");
  const branchRecords = await readJsonlStrict<Branch>(join(ontologyDir, "branches.jsonl"), "ontology/branches.jsonl");

  // ---- source corpus -------------------------------------------------
  const sourceDir = join(novelDir, "source");
  const sourceNames = await readdir(sourceDir).catch(() => [] as string[]);
  const sourceFiles: SourceFileStats[] = [];
  for (const name of sourceNames.sort()) {
    const path = join(sourceDir, name);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) continue;
    const text = await readFile(path, "utf8");
    sourceFiles.push({
      name,
      bytes: st.size,
      characters: text.length,
      chapters: splitChapters(text).length,
      blocks: cutBlocks(text).length,
    });
  }

  // ---- id universe for reference tallies -----------------------------
  const knownIds = new Set<string>();
  for (const e of entities) knownIds.add(e.id);
  for (const t of timelines) knownIds.add(t.id);
  for (const ev of events) knownIds.add(ev.id);
  for (const s of scenes) knownIds.add(s.id);
  for (const b of branchRecords) knownIds.add(b.id);
  const timelineIds = new Set(timelines.map((t) => t.id));

  // ---- coverage -------------------------------------------------------
  const hasCanonical = (e: Entity) => e.names?.some((n) => n.kind === "canonical") ?? false;
  const eventsWithTimeline = events.filter((e) => typeof e.timelineId === "string" && e.timelineId.length > 0);
  const eventsWithEvidence = events.filter(
    (e) => (e.evidence?.text?.trim().length ?? 0) > 0 || (e.evidence?.sentenceIds?.length ?? 0) > 0,
  );
  const totalTurns = scenes.reduce((n, s) => n + (s.turns?.length ?? 0), 0);
  const unresolvedTurns = scenes.reduce(
    (n, s) => n + (s.turns?.filter((t) => t.speakerId === null).length ?? 0),
    0,
  );

  // ---- integrity (dangling references, counted — never repaired) -----
  const danglingFrom = relations.filter((r) => !knownIds.has(r.fromId)).length;
  const danglingTo = relations.filter((r) => !knownIds.has(r.toId)).length;
  const countUnknownRefs = (refs: (string | null | undefined)[]) =>
    refs.filter((r) => r != null && r !== "" && !knownIds.has(r)).length;

  // ---- branch directories ---------------------------------------------
  const branchesRoot = join(novelDir, "branches");
  const branchDirNames = await readdir(branchesRoot).catch(() => [] as string[]);
  const branchDirs: { id: string; files: string[] }[] = [];
  for (const name of branchDirNames.sort()) {
    const path = join(branchesRoot, name);
    const st = await stat(path).catch(() => null);
    if (!st?.isDirectory()) continue;
    const files = (await readdir(path).catch(() => [] as string[])).sort();
    branchDirs.push({ id: name, files });
  }

  // ---- changesets (existing store API, as-is) --------------------------
  const changesets = await listChangeSets(novelDir);

  const graphBuilt = (await stat(join(ontologyDir, "graph.lbug")).catch(() => null)) !== null;

  return {
    novelDir: novelDirArg,
    manifest: {
      novelId: manifest.novelId,
      title: manifest.title,
      schemaVersion: manifest.schemaVersion,
      sourceLanguages: manifest.sourceLanguages,
      decisionModel: manifest.decisionModel,
      embeddingModel: manifest.embeddingModel,
      embeddingDimension: manifest.embeddingDimension,
      blocksProcessed: manifest.blocksProcessed,
    },
    graph: { built: graphBuilt },
    source: {
      files: sourceFiles,
      totals: {
        files: sourceFiles.length,
        bytes: sourceFiles.reduce((n, f) => n + f.bytes, 0),
        characters: sourceFiles.reduce((n, f) => n + f.characters, 0),
        chapters: sourceFiles.reduce((n, f) => n + f.chapters, 0),
        blocks: sourceFiles.reduce((n, f) => n + f.blocks, 0),
      },
    },
    ontology: {
      entities: { total: entities.length, byKind: sortedTally(entities.map((e) => e.kind)) },
      relations: { total: relations.length, byType: sortedTally(relations.map((r) => r.type)) },
      events: {
        total: events.length,
        byType: sortedTally(events.map((e) => e.eventType)),
        byTimeline: sortedTally(events.map((e) => e.timelineId)),
      },
      scenes: {
        total: scenes.length,
        byChapter: sortedTally(scenes.map((s) => String(s.chapterIndex))),
      },
      timelines: { total: timelines.length },
      branches: { total: branchRecords.length },
    },
    coverage: {
      entities: {
        total: entities.length,
        withNames: entities.filter((e) => (e.names?.length ?? 0) > 0).length,
        withoutNames: entities.filter((e) => (e.names?.length ?? 0) === 0).length,
        withCanonicalName: entities.filter(hasCanonical).length,
        withoutCanonicalName: entities.filter((e) => !hasCanonical(e)).length,
      },
      events: {
        total: events.length,
        withTimelineId: eventsWithTimeline.length,
        missingTimelineId: events.length - eventsWithTimeline.length,
        referencingUnknownTimeline: eventsWithTimeline.filter((e) => !timelineIds.has(e.timelineId)).length,
        withEvidence: eventsWithEvidence.length,
        withoutEvidence: events.length - eventsWithEvidence.length,
        evidenceRatio: ratio(eventsWithEvidence.length, events.length),
        withPrimaryActors: events.filter((e) => (e.primaryActors?.length ?? 0) > 0).length,
        withoutPrimaryActors: events.filter((e) => (e.primaryActors?.length ?? 0) === 0).length,
      },
      scenes: {
        total: scenes.length,
        withLocation: scenes.filter((s) => s.locationId !== null && s.locationId !== undefined).length,
        withoutLocation: scenes.filter((s) => s.locationId === null || s.locationId === undefined).length,
        dialogueTurns: totalTurns,
        unresolvedTurns,
      },
    },
    integrity: {
      relations: {
        total: relations.length,
        fullyResolved: relations.filter((r) => knownIds.has(r.fromId) && knownIds.has(r.toId)).length,
        danglingFromRefs: danglingFrom,
        danglingToRefs: danglingTo,
      },
      events: {
        unknownPrimaryActorRefs: countUnknownRefs(events.flatMap((e) => e.primaryActors ?? [])),
        unknownAffectedRefs: countUnknownRefs(events.flatMap((e) => e.affectedCharacters ?? [])),
        unknownTimelineRefs: countUnknownRefs(eventsWithTimeline.map((e) => e.timelineId)),
      },
      scenes: {
        unknownCharacterRefs: countUnknownRefs(
          scenes.flatMap((s) => [...(s.charactersPresent ?? []), ...(s.charactersMentioned ?? [])]),
        ),
        unknownLocationRefs: countUnknownRefs(scenes.map((s) => s.locationId)),
      },
      branches: {
        unknownParentTimelineRefs: countUnknownRefs(branchRecords.map((b) => b.parentTimelineId)),
        unknownForkEventRefs: countUnknownRefs(branchRecords.map((b) => b.forkEventId)),
      },
    },
    branches: { ontologyRecords: branchRecords.length, dirs: branchDirs },
    changesets: {
      total: changesets.length,
      byStatus: sortedTally(changesets.map((c) => c.status)),
      proposalsTotal: changesets.reduce((n, c) => n + c.proposals.length, 0),
    },
  };
}
