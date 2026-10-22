import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BundleStore } from "../connectors/bundle.js";
import type { Entity, OntEvent, Relation, Scene } from "../ontology/types.js";

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
 *
 * `novel eval extract <novel-dir> <predictions-dir>` (evalExtract,
 * below) is the bundle-side producer for the runner: it projects an
 * ingested novel bundle's stored ontology into a predictions directory,
 * split per chapter, so a real ingest can be scored against a golden
 * dataset. Chapter attribution uses only stored fields (see
 * evalExtract); records that no stored field ties to a chapter are
 * counted in the report, never silently dropped or guessed at.
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

// ---------------------------------------------------------------------
// Bundle → predictions adapter (`novel eval extract`)
// ---------------------------------------------------------------------

export interface EvalExtractChapter {
  /** Chapter folder name in the predictions dir (see CHAPTER_ID_RULE). */
  id: string;
  chapterIndex: number;
  entities: number;
  relations: number;
  events: number;
}

export interface EvalExtractResult {
  novelDir: string;
  predictionsDir: string;
  chapterIdRule: string;
  chapters: EvalExtractChapter[];
  /** Records written, summed over chapter folders (a record attributed
   *  to two chapters is written — and counted — in both). */
  written: Record<EvalKind, number>;
  /** Stored records attributed to no chapter: counted here, written
   *  nowhere. Nothing is dropped silently. */
  unattributed: Record<EvalKind, number>;
}

const CHAPTER_ID_RULE =
  "chapter folders are named ch<NN> where NN is the stored chapterIndex " +
  "zero-padded to 2 digits (ch01, ch02, …); name dataset chapters the same way";

/** Chapter folder id for a stored chapterIndex: 1 → "ch01", 2 → "ch02". */
export function chapterFolderId(chapterIndex: number): string {
  return `ch${String(chapterIndex).padStart(2, "0")}`;
}

/**
 * Project an ingested bundle's ontology into an eval predictions dir.
 *
 * Records are copied exactly as stored (ids and every field the matcher
 * uses are preserved verbatim); the only work is the per-chapter split,
 * which uses stored fields only:
 *   events    — their own `chapterIndex`.
 *   entities  — entities carry no chapter field; an entity is projected
 *               into every chapter where a stored scene or event places
 *               it: scene charactersPresent / charactersMentioned /
 *               locationId / dialogue-turn speaker & addressee ids, and
 *               event primaryActors / affectedCharacters.
 *   relations — relations carry no chapter field either; a relation is
 *               projected into the chapters BOTH endpoints are placed
 *               in (an endpoint that is an event or scene id resolves
 *               to that record's chapterIndex; an entity endpoint to
 *               its attested chapters, as above). A cross-chapter
 *               relation (e.g. PRECEDES between two chapters' events)
 *               therefore lands in neither chapter.
 * Records no stored field ties to a chapter are counted under
 * `unattributed` in the report — never guessed at, never dropped
 * silently. The bundle files are read with BundleStore.loadFile, the
 * codebase-standard loader (missing file → no records; a corrupt line
 * is an error naming the file and line). The bundle is append-only
 * with last-write-wins upserts, so entities/events/scenes are deduped
 * by id (last row wins — the same rule the ingest registry uses);
 * relations carry no id and are kept as stored.
 */
export async function evalExtract(
  novelDirArg: string,
  predictionsDirArg: string,
): Promise<EvalExtractResult> {
  const novelDir = resolve(novelDirArg);
  const dirStat = await stat(novelDir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error(`novel directory not found: ${novelDirArg}`);
  }
  const ontologyDir = join(novelDir, "ontology");
  const manifestStat = await stat(join(ontologyDir, "manifest.json")).catch(() => null);
  if (!manifestStat?.isFile()) {
    throw new Error(
      `${novelDirArg} is not a novel workspace (missing ontology/manifest.json). Run \`novel init ${novelDirArg}\` first.`,
    );
  }

  // Never write into a non-empty target: stale chapter files from an
  // earlier projection would silently corrupt the scores (the same
  // never-overwrite rule as bundle import).
  const predictionsDir = resolve(predictionsDirArg);
  const existing = await readdir(predictionsDir).catch(() => null);
  if (existing !== null && existing.length > 0) {
    throw new Error(
      `predictions directory already exists and is not empty: ${predictionsDirArg} — refusing to overwrite; remove it or choose a new directory`,
    );
  }

  const bundle = new BundleStore(ontologyDir);
  const dedupeById = <T extends { id: string }>(rows: T[]): T[] => {
    const byId = new Map<string, T>();
    for (const r of rows) byId.set(r.id, r);
    return [...byId.values()];
  };
  const entities = dedupeById(await bundle.loadFile<Entity>("entities.jsonl"));
  const events = dedupeById(await bundle.loadFile<OntEvent>("events.jsonl"));
  const scenes = dedupeById(await bundle.loadFile<Scene>("scenes.jsonl"));
  const relations = await bundle.loadFile<Relation>("relations.jsonl");

  const chapterOf = (rec: { chapterIndex?: unknown }): number | null =>
    typeof rec.chapterIndex === "number" && Number.isInteger(rec.chapterIndex)
      ? rec.chapterIndex
      : null;

  const eventChapter = new Map<string, number>();
  for (const ev of events) {
    const ch = chapterOf(ev);
    if (ch !== null) eventChapter.set(ev.id, ch);
  }
  const sceneChapter = new Map<string, number>();
  for (const sc of scenes) {
    const ch = chapterOf(sc);
    if (ch !== null) sceneChapter.set(sc.id, ch);
  }

  // Entity attestation: the chapters stored scenes/events place the
  // entity in. Entities have no chapter field of their own.
  const entityChapters = new Map<string, Set<number>>();
  const attest = (id: unknown, ch: number | null): void => {
    if (typeof id !== "string" || id === "" || ch === null) return;
    const set = entityChapters.get(id) ?? new Set<number>();
    set.add(ch);
    entityChapters.set(id, set);
  };
  for (const sc of scenes) {
    const ch = chapterOf(sc);
    for (const id of sc.charactersPresent ?? []) attest(id, ch);
    for (const id of sc.charactersMentioned ?? []) attest(id, ch);
    attest(sc.locationId, ch);
    for (const turn of sc.turns ?? []) {
      attest(turn.speakerId, ch);
      attest(turn.addresseeId, ch);
    }
  }
  for (const ev of events) {
    const ch = chapterOf(ev);
    for (const id of ev.primaryActors ?? []) attest(id, ch);
    for (const id of ev.affectedCharacters ?? []) attest(id, ch);
  }
  // Scene/Event-kind rows are also stored as entities; an entity whose
  // id is a scene or event id sits in that record's chapter.
  for (const e of entities) {
    if (eventChapter.has(e.id)) attest(e.id, eventChapter.get(e.id)!);
    if (sceneChapter.has(e.id)) attest(e.id, sceneChapter.get(e.id)!);
  }

  const endpointChapters = (id: string): Set<number> => {
    if (eventChapter.has(id)) return new Set([eventChapter.get(id)!]);
    if (sceneChapter.has(id)) return new Set([sceneChapter.get(id)!]);
    return entityChapters.get(id) ?? new Set<number>();
  };

  interface Buckets {
    entities: Entity[];
    relations: Relation[];
    events: OntEvent[];
  }
  const buckets = new Map<number, Buckets>();
  const bucket = (ch: number): Buckets => {
    const b = buckets.get(ch) ?? { entities: [], relations: [], events: [] };
    buckets.set(ch, b);
    return b;
  };

  let unattributedEvents = 0;
  for (const ev of events) {
    const ch = chapterOf(ev);
    if (ch === null) unattributedEvents++;
    else bucket(ch).events.push(ev);
  }
  let unattributedEntities = 0;
  for (const e of entities) {
    const chs = entityChapters.get(e.id);
    if (!chs || chs.size === 0) unattributedEntities++;
    else for (const ch of chs) bucket(ch).entities.push(e);
  }
  let unattributedRelations = 0;
  for (const r of relations) {
    const from = endpointChapters(r.fromId);
    const both = [...endpointChapters(r.toId)].filter((ch) => from.has(ch));
    if (both.length === 0) unattributedRelations++;
    else for (const ch of both) bucket(ch).relations.push(r);
  }

  const jsonl = (rows: unknown[]): string =>
    rows.length === 0 ? "" : rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

  await mkdir(predictionsDir, { recursive: true });
  const chapters: EvalExtractChapter[] = [];
  const written: Record<EvalKind, number> = { entities: 0, relations: 0, events: 0 };
  for (const ch of [...buckets.keys()].sort((a, b) => a - b)) {
    const b = buckets.get(ch)!;
    const id = chapterFolderId(ch);
    const dir = join(predictionsDir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "entities.jsonl"), jsonl(b.entities));
    await writeFile(join(dir, "relations.jsonl"), jsonl(b.relations));
    await writeFile(join(dir, "events.jsonl"), jsonl(b.events));
    written.entities += b.entities.length;
    written.relations += b.relations.length;
    written.events += b.events.length;
    chapters.push({
      id,
      chapterIndex: ch,
      entities: b.entities.length,
      relations: b.relations.length,
      events: b.events.length,
    });
  }

  return {
    novelDir: novelDirArg,
    predictionsDir: predictionsDirArg,
    chapterIdRule: CHAPTER_ID_RULE,
    chapters,
    written,
    unattributed: {
      entities: unattributedEntities,
      relations: unattributedRelations,
      events: unattributedEvents,
    },
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
