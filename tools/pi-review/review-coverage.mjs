import { createHash } from 'node:crypto';

export function sourcePage(content, permitted, path) {
  const lines = content.split('\n');
  if (!permitted.count && !permitted.start && lines.length > 150) throw new Error('Use bounded sed pages for sources/references longer than 150 lines');
  const output = permitted.count ? JSON.stringify({ lines: lines.length, path }) : permitted.start ? lines.slice(permitted.start - 1, permitted.end).join('\n') : content;
  if (Buffer.byteLength(output) > 43000) throw new Error('Read a smaller sed page; this output exceeds the safe capture limit');
  return { output, lines };
}

export const reviewRevision = (changeset) => createHash('sha256').update(JSON.stringify({ createdAt: changeset.createdAt, proposals: changeset.proposals, notes: changeset.reviewNotes })).digest('hex');

export function restoreReviewCoverage(entries, changeset) {
  const coverage = { revision: reviewRevision(changeset), proposals: new Set(), notes: new Set() };
  for (const entry of entries) {
    const message = entry.type === 'message' ? entry.message : null;
    if (message?.role !== 'toolResult' || message.isError) continue;
    const text = message.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    let page;
    try { page = JSON.parse(text); } catch { continue; }
    if (page.id !== changeset.id || page.createdAt !== changeset.createdAt || !page.page) continue;
    const { offset, limit, total } = page.page;
    if (!Number.isInteger(offset) || !Number.isInteger(limit) || offset < 0 || limit < 1) continue;
    const notes = !!page.reviewNotes;
    const current = notes ? Object.entries(changeset.reviewNotes) : changeset.proposals;
    if (total !== current.length) continue;
    const expected = current.slice(offset, offset + limit);
    const actual = notes ? Object.entries(page.reviewNotes) : page.proposals;
    if (JSON.stringify(expected) !== JSON.stringify(actual)) continue;
    for (let index = offset; index < Math.min(offset + limit, total); index++) (notes ? coverage.notes : coverage.proposals).add(index);
  }
  return coverage;
}
