export function runOutcome(changesets, records, expectedChapters = 2, unit = 'chapters') {
  const applications = new Map();
  for (const record of records) {
    const event = record.event ?? record;
    if (event.type === 'changeset.applied') applications.set(event.changesetId, event);
  }
  const held = changesets.filter((changeset) => ['held', 'revision_requested'].includes(changeset.status)).map((changeset) => changeset.id);
  const approved = changesets.filter((changeset) => changeset.status === 'approved');
  const applied = approved.filter((changeset) => applications.has(changeset.id));
  const deferred = applied.reduce((total, changeset) => total + applications.get(changeset.id).unsupportedProposalIds.length, 0);
  const unsupported = deferred ? ` · ${deferred} proposals deferred` : '';
  const progress = `${applied.length}/${expectedChapters} ${unit} applied`;
  if (held.length) return { status: 'review', label: `Pi paused · ${held.join(', ')} held · ${progress}${unsupported}`, held, applied: applied.length, deferred };
  if (applied.length === expectedChapters) return { status: 'complete', label: `Pi review complete · ${progress}${unsupported}`, held, applied: applied.length, deferred };
  return { status: 'review', label: `Pi stopped · ${progress} · needs attention${unsupported}`, held, applied: applied.length, deferred };
}
