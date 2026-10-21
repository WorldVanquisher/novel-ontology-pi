/**
 * Deterministic, language-aware sentence sectioning. CODE ONLY — no model.
 *
 * Rule zero of the System 1 design: never ask a model what code can
 * compute exactly. Sectioning, offsets, and window bookkeeping are code.
 *
 * Splits a chapter (or any long block) into paragraphs, then sentences.
 * Every sentence gets a stable ID and character offsets into the block,
 * which become the provenance anchor for everything downstream:
 * miniloop decisions, scenes, events, and change-set proposals all cite
 * sentence IDs.
 *
 * Handles CJK terminal punctuation and quote nesting (。！？「」『』),
 * ellipses (…… / …), and common English abbreviations (Mr., Dr., e.g.).
 */

export interface Sentence {
  /** Stable within a block: "b<block>_s<index>", e.g. "b0003_s0142". */
  id: string;
  index: number;
  paragraphIndex: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

const TERMINAL = new Set(["。", "！", "？", "!", "?", "…"]);
const CLOSERS = new Set(["」", "』", "”", "“", '"', "'", "）", ")", "】", "]"]);
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "st", "jr", "sr", "prof", "sgt", "capt",
  "lt", "gen", "e.g", "i.e", "etc", "vs", "no", "fig", "vol", "ch",
]);

function isTerminatorAt(text: string, i: number): boolean {
  const ch = text[i];
  if (TERMINAL.has(ch)) {
    // English decimal / abbreviation guard: "3.5", "Dr."
    if (ch === "." ) return false;
    return true;
  }
  if (ch === ".") {
    const prev = text.slice(Math.max(0, i - 4), i).toLowerCase();
    const lastWord = prev.split(/[\s"“「]/).pop() ?? "";
    if (ABBREVIATIONS.has(lastWord)) return false;
    const next = text[i + 1];
    if (next && /[0-9]/.test(next)) return false; // decimal point
    return true;
  }
  return false;
}

export function sectionBlock(
  text: string,
  blockIndex: number,
): { sentences: Sentence[]; paragraphCount: number } {
  const sentences: Sentence[] = [];
  const blockId = `b${String(blockIndex).padStart(4, "0")}`;
  const paragraphs = text.split(/\n\s*\n|\n/);
  let globalOffset = 0;
  let sIndex = 0;
  let pCount = 0;

  paragraphs.forEach((para, pIdx) => {
    if (para.trim().length > 0) pCount++;
    const trimmed = para;
    let start = 0;
    let i = 0;
    const push = (end: number) => {
      const raw = trimmed.slice(start, end);
      const t = raw.trim();
      if (t.length > 0) {
        const lead = raw.indexOf(t);
        sentences.push({
          id: `${blockId}_s${String(sIndex).padStart(4, "0")}`,
          index: sIndex,
          paragraphIndex: pIdx,
          text: t,
          startOffset: globalOffset + start + lead,
          endOffset: globalOffset + start + lead + t.length,
        });
        sIndex++;
      }
    };
    while (i < trimmed.length) {
      if (isTerminatorAt(trimmed, i)) {
        // Absorb a run of terminators + closers: 。」 …」 ?! etc.
        let j = i + 1;
        while (
          j < trimmed.length &&
          (TERMINAL.has(trimmed[j]) || trimmed[j] === "." || CLOSERS.has(trimmed[j]))
        ) {
          j++;
        }
        push(j);
        start = j;
        i = j;
      } else {
        i++;
      }
    }
    if (start < trimmed.length) push(trimmed.length);
    globalOffset += para.length + 1; // paragraph separator
  });

  return { sentences, paragraphCount: pCount };
}
