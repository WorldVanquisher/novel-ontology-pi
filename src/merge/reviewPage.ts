import type { ChangeSet } from "./changeset.js";

export function reviewPage(changeset: ChangeSet, options: { offset?: number; limit?: number; notes?: boolean; summary?: boolean }) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Review pagination needs --offset >= 0 and --limit between 1 and 100");
  }
  const counts: Record<string, number> = {};
  for (const proposal of changeset.proposals) counts[proposal.kind] = (counts[proposal.kind] ?? 0) + 1;
  const summary = {
    id: changeset.id, blockId: changeset.blockId, status: changeset.status,
    createdAt: changeset.createdAt, totalProposals: changeset.proposals.length,
    totalNotes: Object.keys(changeset.reviewNotes).length, counts,
  };
  if (options.summary) return summary;
  const total = options.notes ? summary.totalNotes : summary.totalProposals;
  const page = { offset, limit, total, nextOffset: offset + limit < total ? offset + limit : null };
  return options.notes
    ? { ...summary, page, reviewNotes: Object.fromEntries(Object.entries(changeset.reviewNotes).slice(offset, offset + limit)) }
    : { ...summary, page, proposals: changeset.proposals.slice(offset, offset + limit) };
}
