import type { DecisionQuestion } from "../../connectors/jev.js";
import type { Entity } from "../../ontology/types.js";
import type { DecisionPatch, PatchContext, PatchOutcome } from "./types.js";
import { EMPTY_OUTCOME } from "./types.js";
import type { ChangeProposal } from "../../merge/changeset.js";

/**
 * Name Detector patch.
 *
 * Two halves, deliberately split by rule zero:
 *  1. CODE scans the sentences for strings matching names/aliases already
 *     in the main graph (deterministic, exact + alias table). Those hits
 *     are free and certain — no model is asked.
 *  2. The DECISION model judges the rest: candidate spans that might be a
 *     NEW name, or a new nickname for an existing character.
 *
 *  - is_new_name          (noul)  candidate is a person name not in the graph
 *  - is_nickname_for      (choice) candidate refers to one of the known
 *                         characters (+ "none") as a nickname/title
 * Output proposals: upsert_entity (new character stub for the work LLM to
 * flesh out) and add_alias (new nickname for a known character). Both go
 * into the block ChangeSet — the merge gate, not this patch, decides.
 */
export interface NameScanHit {
  sentenceId: string;
  entityId: string;
  matchedText: string;
}

export interface CandidateNomination {
  span: string;
  sentenceId: string;
}

/**
 * Candidate nomination — the code-first half of candidate generation
 * (decision sheet, sector 04): cheap surface patterns nominate spans
 * that MIGHT be names; a zero-context LLM call then extracts the name
 * form, and Jev judges new-vs-nickname. Code never decides — it only
 * nominates, so false positives cost one Jev question, never a bad
 * merge.
 *
 * v1 patterns (Chinese-first, tuned for light-novel prose):
 *  - honorific/title suffixes: 小樱小姐, 王老师, 美琴大人 …
 *  - speech-verb adjacency: 白井黑子说道 / 问道 / 笑道 …
 * Spans already covered by the registry are skipped — a known name is
 * a scan hit, never a candidate.
 */
const SUFFIX_PATTERN =
  /([一-鿿]{1,4}?)(小姐|先生|女士|老师|队长|桑|酱|君|大人|殿下|阁下|师傅|医生)/g;
const SPEECH_PATTERN =
  /([一-鿿]{2,4})(说道|问道|答道|笑道|喊道|叫道|低声道|轻声道|开口道)/g;
const GENERIC_SPANS = new Set([
  "姐姐", "哥哥", "妹妹", "弟弟", "大家", "我们", "你们", "他们",
  "这时", "此时", "于是", "然后", "笑着", "想了想",
]);
const MAX_NOMINATIONS = 24;

export function nominateCandidateSpans(
  sentences: { id: string; text: string }[],
  knownEntities: Entity[],
): CandidateNomination[] {
  const knownForms = knownEntities.flatMap((e) => e.names.map((n) => n.text));
  const isKnown = (span: string) =>
    knownForms.some((f) => f === span || f.includes(span) || span.includes(f));
  const seen = new Set<string>();
  const out: CandidateNomination[] = [];
  const consider = (span: string, sentenceId: string) => {
    if (out.length >= MAX_NOMINATIONS) return;
    if (span.length < 2 || GENERIC_SPANS.has(span) || seen.has(span)) return;
    if (isKnown(span)) return;
    seen.add(span);
    out.push({ span, sentenceId });
  };
  for (const s of sentences) {
    for (const m of s.text.matchAll(SUFFIX_PATTERN)) consider(m[1], s.id);
    for (const m of s.text.matchAll(SPEECH_PATTERN)) {
      const span = m[1];
      if (!/[着了的]$/.test(span)) consider(span, s.id);
    }
  }
  return out;
}

export function scanKnownNames(ctx: PatchContext): NameScanHit[] {
  const hits: NameScanHit[] = [];
  for (const s of ctx.sentences) {
    for (const e of ctx.knownEntities) {
      for (const n of e.names) {
        if (n.text.length > 0 && s.text.includes(n.text)) {
          hits.push({ sentenceId: s.id, entityId: e.id, matchedText: n.text });
        }
      }
    }
  }
  return hits;
}

export const nameDetector: DecisionPatch = {
  id: "name-detector",
  description:
    "Matches known names by code scan; asks the decision model to judge potential new names and nicknames.",
  gates: { accept: 0.8, reask: 0.5 },

  buildQuestions(ctx: PatchContext): DecisionQuestion[] {
    const candidates = (ctx.accepted["nameCandidates"] as string[] | undefined) ?? [];
    const known = ctx.knownEntities.filter((entity) => entity.kind === "Character").map((entity) => entity.id);
    const qs: DecisionQuestion[] = [];
    for (const c of candidates) {
      qs.push({
        key: `newname:${c}`,
        primitive: "noul",
        instructions: `Is "${c}" a character's name (a person being referred to) that does NOT belong to any already-known character?`,
        criteria:
          "Place names, item names, and generic nouns (e.g. 'the teacher') are not character names.",
      });
      qs.push({
        key: `nick:${c}`,
        primitive: "choice",
        instructions: `If "${c}" is a nickname, epithet or title for an already-known character, which one?`,
        options: [...known, "none"],
      });
    }
    return qs;
  },

  applyAnswers(ctx: PatchContext, answers): PatchOutcome {
    const byKey = new Map(answers.map((a) => [a.key, a]));
    const candidates = (ctx.accepted["nameCandidates"] as string[] | undefined) ?? [];
    const proposals: ChangeProposal[] = [];
    const escalations: PatchOutcome["escalations"] = [];

    candidates.forEach((c, i) => {
      const isNew = byKey.get(`newname:${c}`);
      const nick = byKey.get(`nick:${c}`);
      const newProb = typeof isNew?.value === "number" ? isNew.value : 0;
      if (newProb >= this.gates.accept) {
        proposals.push({
          id: `${ctx.blockId}_newchar_${i}`,
          kind: "upsert_entity",
          payload: { candidateName: c, needsExtraction: true },
          confidence: newProb,
          provenance: { blockId: ctx.blockId, sentenceIds: [], patchId: this.id },
        });
      } else if (nick && typeof nick.value === "string" && nick.value !== "none") {
        proposals.push({
          id: `${ctx.blockId}_alias_${i}`,
          kind: "add_alias",
          payload: { entityId: nick.value, aliasText: c },
          confidence: nick.confidence ?? 0.7,
          provenance: { blockId: ctx.blockId, sentenceIds: [], patchId: this.id },
        });
      } else if (newProb >= this.gates.reask) {
        escalations.push({
          unitId: c,
          reason: "possible new name, decision model uncertain",
        });
      }
    });
    return { ...EMPTY_OUTCOME, proposals, escalations };
  },
};
