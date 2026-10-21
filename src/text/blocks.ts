/**
 * Block cutting — deterministic, code only.
 *
 * Ingestion rolls by chapter-or-long-block (DESIGN.md processing model).
 * This module decides the units: first find chapter boundaries, then cut
 * each chapter into blocks of at most `targetChars`, always on paragraph
 * boundaries so a block never starts mid-paragraph. A chapter longer than
 * the target becomes several blocks sharing its chapterIndex.
 *
 * Chapter headings recognized (line-anchored, multilingual):
 *   第X章 / 第X話 / 第X节 / 第X回  (CJK numerals or digits, incl. fullwidth)
 *   序章 / 終章 / 番外編 / プロローグ / エピローグ
 *   Chapter N / CHAPTER N / Prologue / Epilogue
 * Text before the first heading is chapter 0 ("front matter").
 */

export interface Chapter {
  index: number;
  title: string | null;
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface Block {
  /** "b0001", "b0002", … — stable for a given (text, targetChars). */
  id: string;
  index: number;
  chapterIndex: number;
  chapterTitle: string | null;
  startOffset: number;
  endOffset: number;
  charCount: number;
  text: string;
}

const CN_NUM = "[0-9０-９一二三四五六七八九十百千两零〇]";
const HEADING_PATTERNS: RegExp[] = [
  new RegExp(`^\\s*第\\s*${CN_NUM}+\\s*[章話话节節回卷]`),
  /^\s*(序章|終章|终章|番外編|番外编|プロローグ|エピローグ)/,
  /^\s*(Chapter|CHAPTER|Prologue|Epilogue)\s+\d+/,
  /^\s*(Prologue|Epilogue)\s*$/,
];

function isHeading(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 60) return false;
  return HEADING_PATTERNS.some((re) => re.test(t));
}

/** Split raw novel text into chapters by heading lines. */
export function splitChapters(text: string): Chapter[] {
  const lines = text.split("\n");
  const starts: { lineIndex: number; offset: number; title: string }[] = [];
  let offset = 0;
  const lineOffsets: number[] = [];
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1; // +\n
  }
  lines.forEach((line, i) => {
    if (isHeading(line)) {
      starts.push({ lineIndex: i, offset: lineOffsets[i], title: line.trim() });
    }
  });

  const chapters: Chapter[] = [];
  if (!starts.length || starts[0].offset > 0) {
    const end = starts.length ? starts[0].offset : text.length;
    const front = text.slice(0, end);
    if (front.trim().length > 0) {
      chapters.push({
        index: 0,
        title: null,
        startOffset: 0,
        endOffset: end,
        text: front,
      });
    }
  }
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].offset : text.length;
    chapters.push({
      index: chapters.length,
      title: s.title,
      startOffset: s.offset,
      endOffset: end,
      text: text.slice(s.offset, end),
    });
  });
  return chapters;
}

/** Paragraphs of a chapter, with offsets relative to the chapter start. */
function paragraphs(chapterText: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const lines = chapterText.split("\n");
  let offset = 0;
  let curStart: number | null = null;
  let curEnd = 0;
  const flush = () => {
    if (curStart !== null) out.push({ start: curStart, end: curEnd });
    curStart = null;
  };
  for (const line of lines) {
    const lineEnd = offset + line.length;
    if (line.trim().length === 0) {
      flush();
    } else {
      if (curStart === null) curStart = offset;
      curEnd = lineEnd;
    }
    offset = lineEnd + 1;
  }
  flush();
  // Single-newline novels (common for CJK web novels): each line already
  // flushed as its own paragraph only if blank lines exist; if the whole
  // chapter came out as one blob with internal newlines, split per line.
  if (out.length === 1 && chapterText.includes("\n")) {
    const per: { start: number; end: number }[] = [];
    let off = 0;
    for (const line of lines) {
      if (line.trim().length > 0) per.push({ start: off, end: off + line.length });
      off += line.length + 1;
    }
    if (per.length > 1) return per;
  }
  return out;
}

/**
 * Cut a novel into processing blocks: chapters first, then size-capped
 * on paragraph boundaries. `targetChars` default matches the design's
 * chapter-or-long-block roll (≈ a long chapter stays one block).
 */
export function cutBlocks(text: string, targetChars = 24000): Block[] {
  const chapters = splitChapters(text);
  const blocks: Block[] = [];
  let n = 0;
  for (const ch of chapters) {
    const paras = paragraphs(ch.text);
    let curStart: number | null = null;
    let curEnd = 0;
    const flush = () => {
      if (curStart === null) return;
      n += 1;
      blocks.push({
        id: `b${String(n).padStart(4, "0")}`,
        index: n - 1,
        chapterIndex: ch.index,
        chapterTitle: ch.title,
        startOffset: ch.startOffset + curStart,
        endOffset: ch.startOffset + curEnd,
        charCount: curEnd - curStart,
        text: ch.text.slice(curStart, curEnd),
      });
      curStart = null;
    };
    for (const p of paras) {
      if (curStart !== null && p.end - curStart > targetChars) flush();
      if (curStart === null) curStart = p.start;
      curEnd = p.end;
    }
    flush();
  }
  return blocks;
}
