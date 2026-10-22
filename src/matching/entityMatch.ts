import type { DecisionModel, DecisionQuestion } from "../connectors/jev.js";
import type { Entity, OntEvent } from "../ontology/types.js";

/**
 * Entity matching — the gate's first-stage review for the oldest
 * failure mode in extraction: the same entity recorded twice.
 *
 * Three layers, in the project's usual order:
 *  1. CODE nominates pairs (same kind only) with explainable reasons:
 *     shared name forms, script-variant folds (黒子 vs 黑子),
 *     containment （食蜂 ⊂ 食蜂操祈）, near-identical forms.
 *  2. SYSTEM 1 reviews the batch: ONE batched Jev call answers a
 *     three-question checklist per pair (same entity? treated as
 *     distinct? mere form variant?). System 1 settles what it can —
 *     the main agent is not bothered with pairs the checklist
 *     resolves confidently.
 *  3. ROUTING is deterministic: distinct-verdicts and low scores are
 *     settled/logged; CONFIDENT pairs become ready-to-apply merge
 *     fixes; UNCERTAIN pairs are the ones raised to the main agent
 *     as real review requests, checklist attached.
 */

export interface MatchCandidate {
  aId: string;
  bId: string;
  kind: string;
  aForms: string[];
  bForms: string[];
  reasons: string[];
  codeScore: number;
}

export interface MatchVerdict extends MatchCandidate {
  checklist: { same: number; distinct: number; variant: number };
  score: number;
  verdict: "confident" | "uncertain" | "rejected" | "distinct";
  /** Suggested merge direction for confident/uncertain pairs. */
  keepId: string;
  dropId: string;
}

/** Common CJK script variants, folded to the first char of each pair. */
const VARIANT_PAIRS: [string, string][] = [
  ["黑", "黒"], ["泽", "沢"], ["泽", "澤"], ["岛", "島"], ["宫", "宮"],
  ["园", "園"], ["会", "會"], ["国", "國"], ["学", "學"], ["队", "隊"],
  ["长", "長"], ["门", "門"], ["风", "風"], ["云", "雲"], ["龙", "龍"],
  ["马", "馬"], ["车", "車"], ["书", "書"], ["语", "語"], ["时", "時"],
  ["现", "現"], ["点", "點"], ["线", "線"], ["气", "氣"], ["热", "熱"],
  ["电", "電"], ["话", "話"], ["说", "說"], ["读", "讀"], ["写", "寫"],
  ["听", "聽"], ["见", "見"], ["开", "開"], ["关", "關"], ["乐", "樂"],
  ["东", "東"], ["个", "個"], ["们", "們"], ["这", "這"], ["对", "對"],
  ["实", "實"], ["图", "圖"], ["广", "廣"], ["场", "場"], ["达", "達"],
  ["进", "進"], ["过", "過"], ["还", "還"], ["边", "邊"], ["远", "遠"],
  ["运", "運"], ["动", "動"], ["医", "醫"], ["员", "員"], ["圆", "圓"],
  ["团", "團"], ["响", "響"], ["与", "與"], ["为", "為"], ["后", "後"],
];
const FOLD = new Map<string, string>();
for (const [a, b] of VARIANT_PAIRS) {
  FOLD.set(b, a);
  FOLD.set(a, a);
}
export const foldVariants = (s: string): string =>
  [...s].map((ch) => FOLD.get(ch) ?? ch).join("");

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const t = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return row[n];
}

const MAX_CANDIDATES = 40;

export function nominateMatchCandidates(entities: Entity[]): MatchCandidate[] {
  const byPair = new Map<string, MatchCandidate>();
  const add = (a: Entity, b: Entity, reason: string, score: number) => {
    const key = [a.id, b.id].sort().join("|");
    const existing = byPair.get(key);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      existing.codeScore = Math.max(existing.codeScore, score);
      return;
    }
    byPair.set(key, {
      aId: a.id,
      bId: b.id,
      kind: a.kind,
      aForms: a.names.map((n) => n.text),
      bForms: b.names.map((n) => n.text),
      reasons: [reason],
      codeScore: score,
    });
  };
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i], b = entities[j];
      if (a.kind !== b.kind) continue;
      for (const fa of a.names.map((n) => n.text)) {
        for (const fb of b.names.map((n) => n.text)) {
          if (fa === fb) add(a, b, `shared name form "${fa}"`, 0.95);
          else if (foldVariants(fa) === foldVariants(fb))
            add(a, b, `script-variant forms "${fa}" / "${fb}"`, 0.9);
          else if (
            fa.length >= 2 && fb.length >= 2 &&
            (fa.includes(fb) || fb.includes(fa))
          )
            add(a, b, `name containment "${fa}" / "${fb}"`, 0.8);
          else if (
            fa.length >= 3 && fb.length >= 3 &&
            levenshtein(foldVariants(fa), foldVariants(fb)) <= 1
          )
            add(a, b, `near-identical forms "${fa}" / "${fb}"`, 0.7);
        }
      }
    }
  }
  return [...byPair.values()]
    .sort((x, y) => y.codeScore - x.codeScore)
    .slice(0, MAX_CANDIDATES);
}

function eventSamples(entityId: string, events: OntEvent[], n = 2): string[] {
  return events
    .filter((e) => e.primaryActors.includes(entityId) || e.affectedCharacters.includes(entityId))
    .slice(0, n)
    .map((e) => e.summaryEn);
}

function participations(entityId: string, events: OntEvent[]): number {
  return events.filter(
    (e) => e.primaryActors.includes(entityId) || e.affectedCharacters.includes(entityId),
  ).length;
}

export const CONFIDENT_THRESHOLD = 0.85;
export const UNCERTAIN_THRESHOLD = 0.45;
export const DISTINCT_THRESHOLD = 0.6;

/**
 * The System 1 checklist: one batched decide() for the whole batch of
 * candidates (never one call per pair), then deterministic routing.
 */
export async function checkMatches(
  decisions: DecisionModel,
  candidates: MatchCandidate[],
  entities: Entity[],
  events: OntEvent[],
): Promise<MatchVerdict[]> {
  if (candidates.length === 0) return [];
  const byId = new Map(entities.map((e) => [e.id, e]));
  const dossier = candidates
    .map((c, i) => {
      const a = byId.get(c.aId)!, b = byId.get(c.bId)!;
      const ea = eventSamples(c.aId, events).join(" | ") || "(no recorded events)";
      const eb = eventSamples(c.bId, events).join(" | ") || "(no recorded events)";
      return (
        `PAIR ${i}: A=${a.id} (${a.kind}) names=[${c.aForms.join(", ")}] events: ${ea}\n` +
        `        B=${b.id} (${b.kind}) names=[${c.bForms.join(", ")}] events: ${eb}\n` +
        `        nominated because: ${c.reasons.join("; ")}`
      );
    })
    .join("\n");
  const questions: DecisionQuestion[] = [];
  candidates.forEach((c, i) => {
    questions.push(
      {
        key: `same:${i}`,
        primitive: "noul",
        instructions: `For PAIR ${i}: are A and B the same ${c.kind} — one entity that was recorded twice — rather than two distinct ${c.kind}s?`,
      },
      {
        key: `distinct:${i}`,
        primitive: "noul",
        instructions: `For PAIR ${i}: does the narrative treat A and B as two separate ${c.kind}s at once — for example both acting independently in the same scene?`,
      },
      {
        key: `variant:${i}`,
        primitive: "noul",
        instructions: `For PAIR ${i}: is the difference between A's and B's name forms only a script variant, abbreviation, or shortened form of the same underlying name?`,
      },
    );
  });
  const answers = await decisions.decide(
    `Entity-matching review. Decide each pair on the evidence given.\n${dossier}`,
    questions,
  );
  const prob = (key: string): number => {
    const a = answers.find((x) => x.key === key);
    return typeof a?.value === "number" ? a.value : 0;
  };
  return candidates.map((c, i) => {
    const checklist = {
      same: prob(`same:${i}`),
      distinct: prob(`distinct:${i}`),
      variant: prob(`variant:${i}`),
    };
    const verdict: MatchVerdict["verdict"] =
      checklist.distinct >= DISTINCT_THRESHOLD
        ? "distinct"
        : checklist.same >= CONFIDENT_THRESHOLD
          ? "confident"
          : checklist.same >= UNCERTAIN_THRESHOLD
            ? "uncertain"
            : "rejected";
    const pa = participations(c.aId, events);
    const pb = participations(c.bId, events);
    const keepA =
      pa !== pb ? pa > pb : c.aForms.length !== c.bForms.length ? c.aForms.length > c.bForms.length : c.aId < c.bId;
    return {
      ...c,
      checklist,
      score: checklist.same,
      verdict,
      keepId: keepA ? c.aId : c.bId,
      dropId: keepA ? c.bId : c.aId,
    };
  });
}
