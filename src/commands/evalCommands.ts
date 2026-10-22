import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * `novel eval run <dataset-dir> <predictions-dir>` — golden-chapter eval
 * scaffolding (Phase 2 measurement tooling).
 *
 * The runner scores PREDICTIONS AS DATA: it never calls a model. A
 * predictions directory holds, per chapter, the same JSONL record files
 * a bundle holds (entities/relations/events.jsonl, in the bundle's own
 * record shapes — src/ontology/types.ts). Any producer can write them:
 * a recorded pipeline run, a mock, or a future live run. Swapping the
 * producer changes nothing here.
 *
 * The report is metrics only — TP/FP/FN, precision, recall, F1, and the
 * missed/spurious record keys for human inspection. There are NO
 * thresholds, no pass/fail, and no quality judgments: a completed
 * scoring run exits 0 whatever the numbers are. What the numbers mean,
 * and what (if anything) they should gate, is the maintainer's call.
 *
 * Matching rule (part of the dataset format spec — see README):
 * records are matched per chapter and kind in two passes.
 *   Pass 1 — exact id: a predicted record whose `id` equals a golden
 *     record's `id` matches it. (Producers that preserve ids, e.g.
 *     recorded runs, match here.)
 *   Pass 2 — semantic key, over the records left over:
 *     entity:   `entity:<kind>:<canonical name>` — the names[] entry
 *               with kind "canonical", else the first name.
 *     relation: `relation:<type>:<from>-><to>` where each endpoint is
 *               the semantic key of the record it references IN THE
 *               SAME chapter and side (golden relations resolve against
 *               golden records, predictions against their own), or
 *               `id:<raw id>` when the endpoint does not resolve.
 *     event:    `event:<timelineId>:<summary>` with the summary
 *               normalized (trimmed, whitespace-collapsed, lowercased).
 *   Matching is a multiset match: duplicate keys pair off one-for-one.
 * Ids are otherwise ignored — producers assign their own, so semantic
 * keys are what make independently produced predictions comparable.
 */

export const EVAL_KINDS = ["entities", "relations", "events"] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];

type Rec = Record<string, unknown>;

export interface Score {
  tp: number;
  fp: number;
  fn: number;
  /** tp/(tp+fp); null when there were no predictions for the slice. */
  precision: number | null;
  /** tp/(tp+fn); null when there were no golden records for the slice. */
  recall: number | null;
  /** Harmonic mean of precision/recall; null when either is null or both are 0. */
  f1: number | null;
}

export interface KeyRef {
  chapter: string;
  kind: EvalKind;
  key: string;
}

export interface EvalResult {
  dataset: { dir: string; name: string | null; chapters: string[] };
  predictionsDir: string;
  matchingRule: string;
  kinds: Record<EvalKind, Score>;
  overall: Score;
  chapters: { id: string; kinds: Record<EvalKind, Score>; overall: Score }[];
  /** Golden records no prediction matched (false negatives), by key. */
  missed: KeyRef[];
  /** Predicted records no golden record matched (false positives), by key. */
  spurious: KeyRef[];
}

const MATCHING_RULE =
  "pass 1: exact id match; pass 2: semantic key — entity: kind+canonical name; " +
  "relation: type+endpoint keys (endpoints resolved within the same chapter/side, raw id when unresolved); " +
  "event: timelineId+normalized summaryEn. Multiset matching per chapter and kind.";

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function score(tp: number, fp: number, fn: number): Score {
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return {
    tp,
    fp,
    fn,
    precision: precision === null ? null : round4(precision),
    recall: recall === null ? null : round4(recall),
    f1: f1 === null ? null : round4(f1),
  };
}

// ---------------------------------------------------------------------
// Dataset / prediction loading — strict, errors name file + line.
// ---------------------------------------------------------------------

interface DatasetChapter {
  id: string;
  source?: string;
  golden: string;
}

interface Dataset {
  name: string | null;
  chapters: DatasetChapter[];
}

async function loadDataset(datasetDir: string): Promise<Dataset> {
  const path = join(datasetDir, "dataset.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`eval dataset not found: ${path} — a dataset directory needs a dataset.json (see README, "Golden-chapter eval datasets")`);
    }
    throw err;
  }
  let parsed: Rec;
  try {
    parsed = JSON.parse(raw) as Rec;
  } catch (err) {
    throw new Error(`invalid dataset manifest ${path}: ${String(err)}`);
  }
  if (!Array.isArray(parsed.chapters) || parsed.chapters.length === 0) {
    throw new Error(`invalid dataset manifest ${path}: "chapters" must be a non-empty array`);
  }
  const seen = new Set<string>();
  const chapters: DatasetChapter[] = [];
  for (const [i, c] of (parsed.chapters as Rec[]).entries()) {
    if (typeof c?.id !== "string" || typeof c?.golden !== "string") {
      throw new Error(`invalid dataset manifest ${path}: chapters[${i}] needs string "id" and "golden" (chapter dir relative to the dataset)`);
    }
    if (seen.has(c.id)) {
      throw new Error(`invalid dataset manifest ${path}: duplicate chapter id "${c.id}"`);
    }
    seen.add(c.id);
    if (c.source !== undefined) {
      if (typeof c.source !== "string") {
        throw new Error(`invalid dataset manifest ${path}: chapters[${i}].source must be a string path`);
      }
      const found = await stat(join(datasetDir, c.source)).catch(() => null);
      if (!found) {
        throw new Error(`dataset chapter "${c.id}": source file not found: ${join(datasetDir, c.source)}`);
      }
    }
    chapters.push({ id: c.id, source: c.source as string | undefined, golden: c.golden });
  }
  return { name: typeof parsed.name === "string" ? parsed.name : null, chapters };
}

/** A chapter directory may only contain the three scored JSONL files. */
async function checkChapterDir(dir: string, role: string, chapterId: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => null);
  if (entries === null) return false;
  for (const name of entries.sort()) {
    if (name.endsWith(".jsonl") && !EVAL_KINDS.includes(name.replace(/\.jsonl$/, "") as EvalKind)) {
      throw new Error(
        `unknown record file in ${role} chapter "${chapterId}": ${join(dir, name)} — only entities.jsonl, relations.jsonl, events.jsonl are scored`,
      );
    }
  }
  return true;
}

async function loadKindFile(
  dir: string,
  kind: EvalKind,
  role: "golden" | "predictions",
  chapterId: string,
): Promise<Rec[]> {
  const path = join(dir, `${kind}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (role === "golden") {
        throw new Error(`golden chapter "${chapterId}" is missing its ${kind}.jsonl: ${path} (write an empty file for a kind with no records)`);
      }
      return []; // a producer may emit nothing for a kind
    }
    throw err;
  }
  const out: Rec[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(lines[i]);
    } catch (err) {
      throw new Error(`corrupt JSONL in ${role} chapter "${chapterId}": ${path} line ${i + 1}: ${String(err)}`);
    }
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
      throw new Error(`invalid record in ${role} chapter "${chapterId}": ${path} line ${i + 1}: expected a JSON object`);
    }
    out.push(rec as Rec);
  }
  return out;
}

// ---------------------------------------------------------------------
// Semantic keys
// ---------------------------------------------------------------------

function fail(role: string, chapterId: string, path: string, line: number, what: string): never {
  throw new Error(`invalid ${role} record in chapter "${chapterId}": ${path} line ${line}: ${what}`);
}

function entityKey(rec: Rec, role: string, chapterId: string, path: string, line: number): string {
  const names = rec.names as { text?: unknown; kind?: unknown }[] | undefined;
  const canonical =
    names?.find((n) => n?.kind === "canonical" && typeof n.text === "string") ??
    names?.find((n) => typeof n?.text === "string");
  if (typeof rec.kind !== "string" || !canonical) {
    fail(role, chapterId, path, line, `entity needs a string "kind" and at least one name with text`);
  }
  return `entity:${rec.kind}:${(canonical as { text: string }).text}`;
}

function normalizeSummary(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function eventKey(rec: Rec, role: string, chapterId: string, path: string, line: number): string {
  if (typeof rec.timelineId !== "string" || typeof rec.summaryEn !== "string") {
    fail(role, chapterId, path, line, `event needs string "timelineId" and "summaryEn"`);
  }
  return `event:${rec.timelineId}:${normalizeSummary(rec.summaryEn as string)}`;
}

/** Map of id → semantic key for one chapter/side, for endpoint resolution. */
function idKeyMap(
  entities: Rec[],
  events: Rec[],
  role: string,
  chapterId: string,
  dir: string,
): Map<string, string> {
  const map = new Map<string, string>();
  entities.forEach((r, i) => {
    if (typeof r.id === "string") map.set(r.id, entityKey(r, role, chapterId, join(dir, "entities.jsonl"), i + 1));
  });
  events.forEach((r, i) => {
    if (typeof r.id === "string") map.set(r.id, eventKey(r, role, chapterId, join(dir, "events.jsonl"), i + 1));
  });
  return map;
}

function relationKey(
  rec: Rec,
  resolve: Map<string, string>,
  role: string,
  chapterId: string,
  path: string,
  line: number,
): string {
  if (typeof rec.type !== "string" || typeof rec.fromId !== "string" || typeof rec.toId !== "string") {
    fail(role, chapterId, path, line, `relation needs string "type", "fromId" and "toId"`);
  }
  const from = resolve.get(rec.fromId as string) ?? `id:${rec.fromId}`;
  const to = resolve.get(rec.toId as string) ?? `id:${rec.toId}`;
  return `relation:${rec.type}:${from}->${to}`;
}

// ---------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------

interface ChapterSide {
  records: Record<EvalKind, Rec[]>;
  keys: Record<EvalKind, (string | null)[]>;
  ids: Record<EvalKind, (string | null)[]>;
}

function prepareSide(
  records: Record<EvalKind, Rec[]>,
  role: "golden" | "predictions",
  chapterId: string,
  dir: string,
): ChapterSide {
  const resolve = idKeyMap(records.entities, records.events, role, chapterId, dir);
  const keys: ChapterSide["keys"] = { entities: [], relations: [], events: [] };
  const ids: ChapterSide["ids"] = { entities: [], relations: [], events: [] };
  for (const kind of EVAL_KINDS) {
    records[kind].forEach((rec, i) => {
      const path = join(dir, `${kind}.jsonl`);
      ids[kind].push(typeof rec.id === "string" && rec.id !== "" ? rec.id : null);
      if (kind === "entities") keys[kind].push(entityKey(rec, role, chapterId, path, i + 1));
      else if (kind === "events") keys[kind].push(eventKey(rec, role, chapterId, path, i + 1));
      else keys[kind].push(relationKey(rec, resolve, role, chapterId, path, i + 1));
    });
  }
  return { records, keys, ids };
}

/** Run both matching passes; returns the true-positive count. */
function matchKind(
  gold: ChapterSide,
  pred: ChapterSide,
  kind: EvalKind,
  chapterId: string,
  missed: KeyRef[],
  spurious: KeyRef[],
): number {
  const goldLeft = new Set(gold.keys[kind].map((_, i) => i));
  const predLeft = new Set(pred.keys[kind].map((_, i) => i));
  let tp = 0;

  // Pass 1 — exact id.
  const goldById = new Map<string, number[]>();
  for (const i of goldLeft) {
    const id = gold.ids[kind][i];
    if (id !== null) goldById.set(id, [...(goldById.get(id) ?? []), i]);
  }
  for (const j of [...predLeft]) {
    const id = pred.ids[kind][j];
    if (id === null) continue;
    const queue = goldById.get(id);
    if (queue && queue.length > 0) {
      goldLeft.delete(queue.shift()!);
      predLeft.delete(j);
      tp++;
    }
  }

  // Pass 2 — semantic keys, multiset over the leftovers.
  const goldKeyCounts = new Map<string, number>();
  for (const i of goldLeft) goldKeyCounts.set(gold.keys[kind][i]!, (goldKeyCounts.get(gold.keys[kind][i]!) ?? 0) + 1);
  for (const j of [...predLeft]) {
    const key = pred.keys[kind][j]!;
    const available = goldKeyCounts.get(key) ?? 0;
    if (available > 0) {
      goldKeyCounts.set(key, available - 1);
      predLeft.delete(j);
      tp++;
    }
  }

  for (const i of goldLeft) {
    const key = gold.keys[kind][i]!;
    const remaining = goldKeyCounts.get(key) ?? 0;
    if (remaining > 0) {
      goldKeyCounts.set(key, remaining - 1);
      missed.push({ chapter: chapterId, kind, key });
    }
  }
  for (const j of predLeft) spurious.push({ chapter: chapterId, kind, key: pred.keys[kind][j]! });

  return tp;
}

// ---------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------

export async function evalRun(datasetDirArg: string, predictionsDirArg: string): Promise<EvalResult> {
  const datasetDir = resolve(datasetDirArg);
  const predictionsDir = resolve(predictionsDirArg);
  const predStat = await stat(predictionsDir).catch(() => null);
  if (!predStat?.isDirectory()) {
    throw new Error(`predictions directory not found: ${predictionsDirArg}`);
  }
  const dataset = await loadDataset(datasetDir);

  // Unknown prediction chapters are an error: silently ignoring a whole
  // chapter of predictions would corrupt the scores.
  const chapterIds = new Set(dataset.chapters.map((c) => c.id));
  const predEntries = await readdir(predictionsDir);
  for (const name of predEntries.sort()) {
    const st = await stat(join(predictionsDir, name)).catch(() => null);
    if (st?.isDirectory() && !chapterIds.has(name)) {
      throw new Error(`predictions contain unknown chapter "${name}": ${join(predictionsDir, name)} — dataset chapters are: ${[...chapterIds].join(", ")}`);
    }
  }

  const missed: KeyRef[] = [];
  const spurious: KeyRef[] = [];
  const chapterResults: EvalResult["chapters"] = [];
  const kindTotals: Record<EvalKind, { tp: number; fp: number; fn: number }> = {
    entities: { tp: 0, fp: 0, fn: 0 },
    relations: { tp: 0, fp: 0, fn: 0 },
    events: { tp: 0, fp: 0, fn: 0 },
  };

  for (const chapter of dataset.chapters) {
    const goldDir = join(datasetDir, chapter.golden);
    if (!(await checkChapterDir(goldDir, "golden", chapter.id))) {
      throw new Error(`golden chapter "${chapter.id}" not found: ${goldDir}`);
    }
    const predDir = join(predictionsDir, chapter.id);
    const predExists = await checkChapterDir(predDir, "predictions", chapter.id);

    const goldRecords = {} as Record<EvalKind, Rec[]>;
    const predRecords = {} as Record<EvalKind, Rec[]>;
    for (const kind of EVAL_KINDS) {
      goldRecords[kind] = await loadKindFile(goldDir, kind, "golden", chapter.id);
      predRecords[kind] = predExists ? await loadKindFile(predDir, kind, "predictions", chapter.id) : [];
    }
    const gold = prepareSide(goldRecords, "golden", chapter.id, goldDir);
    const pred = prepareSide(predRecords, "predictions", chapter.id, predDir);

    const kinds = {} as Record<EvalKind, Score>;
    let cTp = 0, cFp = 0, cFn = 0;
    for (const kind of EVAL_KINDS) {
      const s = matchKindScored(gold, pred, kind, chapter.id, missed, spurious);
      kinds[kind] = s;
      kindTotals[kind].tp += s.tp;
      kindTotals[kind].fp += s.fp;
      kindTotals[kind].fn += s.fn;
      cTp += s.tp; cFp += s.fp; cFn += s.fn;
    }
    chapterResults.push({ id: chapter.id, kinds, overall: score(cTp, cFp, cFn) });
  }

  const byKind = {} as Record<EvalKind, Score>;
  let tTp = 0, tFp = 0, tFn = 0;
  for (const kind of EVAL_KINDS) {
    const t = kindTotals[kind];
    byKind[kind] = score(t.tp, t.fp, t.fn);
    tTp += t.tp; tFp += t.fp; tFn += t.fn;
  }
  const byKey = (a: KeyRef, b: KeyRef) =>
    a.chapter === b.chapter
      ? a.kind === b.kind
        ? a.key < b.key ? -1 : a.key > b.key ? 1 : 0
        : a.kind < b.kind ? -1 : 1
      : a.chapter < b.chapter ? -1 : 1;

  return {
    dataset: { dir: datasetDirArg, name: dataset.name, chapters: dataset.chapters.map((c) => c.id) },
    predictionsDir: predictionsDirArg,
    matchingRule: MATCHING_RULE,
    kinds: byKind,
    overall: score(tTp, tFp, tFn),
    chapters: chapterResults,
    missed: missed.sort(byKey),
    spurious: spurious.sort(byKey),
  };
}

/** matchKind with clean TP/FP/FN accounting (see matchKind for passes). */
function matchKindScored(
  gold: ChapterSide,
  pred: ChapterSide,
  kind: EvalKind,
  chapterId: string,
  missed: KeyRef[],
  spurious: KeyRef[],
): Score {
  const tp = matchKind(gold, pred, kind, chapterId, missed, spurious);
  return score(tp, pred.keys[kind].length - tp, gold.keys[kind].length - tp);
}
