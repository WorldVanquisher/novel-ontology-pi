import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { reviewRevision } from './review-coverage.mjs';

const rows = async (path) => readFile(path, 'utf8').then((value) => value.split('\n').filter(Boolean).map(JSON.parse), (error) => { if (error.code === 'ENOENT') return []; throw error; });
const fold = (entries) => [...new Map(entries.map((entry) => [entry.id, entry])).values()];
export const nonCjkNarrative = (value) => /\p{L}/u.test(value ?? '') && !/[\u4e00-\u9fff]/.test(value ?? '');

export function structuralIssues(entities, events, scenes, relations) {
  const kinds = new Map(entities.map((entity) => [entity.id, entity.kind]));
  const ids = new Set([...kinds.keys(), ...events.map((event) => event.id), ...scenes.map((scene) => scene.id)]);
  const issues = [];
  const characters = (values, record) => { for (const id of values ?? []) if (kinds.get(id) !== 'Character') issues.push({ code: 'invalid-character-reference', record, id }); };
  for (const event of events) { characters(event.primaryActors, event.id); characters(event.affectedCharacters, event.id); }
  for (const scene of scenes) {
    characters(scene.charactersPresent, scene.id);
    characters(scene.charactersMentioned, scene.id);
    for (const turn of scene.turns ?? []) characters([turn.speakerId, turn.addresseeId].filter(Boolean), scene.id);
    if (scene.locationId && kinds.get(scene.locationId) !== 'Location') issues.push({ code: 'invalid-location-reference', record: scene.id });
    if ((scene.charactersPresent ?? []).some((id) => scene.charactersMentioned?.includes(id))) issues.push({ code: 'overlapping-presence-and-mention', record: scene.id });
  }
  for (const relation of relations) if (!ids.has(relation.fromId) || !ids.has(relation.toId)) issues.push({ code: 'dangling-relation', from: relation.fromId, to: relation.toId });
  return issues;
}

export async function validateStability(jobRoot, manifest) {
  const receipts = await rows(`${jobRoot}/approval-receipts.jsonl`);
  const issues = [];
  const states = [];
  let languageWarnings = 0;
  for (const volume of manifest.volumes) {
    const records = await rows(`${volume.workspace}/events.jsonl`);
    const applications = new Map(records.filter((record) => record.event.type === 'changeset.applied').map((record) => [record.event.changesetId, record.event]));
    for (const block of volume.blocks) {
      const packet = await readFile(`${volume.workspace}/changesets/cs_${block.id}.json`, 'utf8').then(JSON.parse, (error) => { if (error.code === 'ENOENT') return null; throw error; });
      const receipt = receipts.findLast((entry) => entry.volume === volume.id && entry.blockId === block.id);
      const application = applications.get(`cs_${block.id}`);
      const applied = packet?.status === 'approved' && !!application;
      const reviewed = !!packet && !!receipt && receipt.revision === reviewRevision(packet) && receipt.reviewedProposals === packet.proposals.length && receipt.reviewedNotes === Object.keys(packet.reviewNotes).length && receipt.sourceLines === block.lines && receipt.coveredSourceLines >= block.lines;
      if (applied && !reviewed) issues.push({ code: 'missing-current-review-proof', blockId: block.id, volume: volume.id });
      states.push({ volume: volume.id, blockId: block.id, chapterIndex: block.chapterIndex, applied, reviewed, status: packet?.status ?? 'not-started', supported: application ? application.processed - application.unsupportedProposalIds.length : 0, deferred: application?.unsupportedProposalIds.length ?? 0 });
    }
    const [entities, events, scenes, relations] = await Promise.all(['entities', 'events', 'scenes', 'relations'].map((file) => rows(`${volume.workspace}/ontology/${file}.jsonl`)));
    issues.push(...structuralIssues(fold(entities), fold(events), fold(scenes), relations));
    const source = await readFile(volume.input, 'utf8');
    if (/[\u4e00-\u9fff]/.test(source)) languageWarnings += fold(events).filter((event) => nonCjkNarrative(event.summaryEn)).length;
  }
  const chapters = [...new Set(states.map((state) => `${state.volume}:${state.chapterIndex}`))];
  const completedChapters = chapters.filter((chapter) => states.filter((state) => `${state.volume}:${state.chapterIndex}` === chapter).every((state) => state.applied && state.reviewed)).length;
  return { complete: states.every((state) => state.applied && state.reviewed) && !issues.length && !languageWarnings, completedChapters, targetChapters: chapters.length, appliedBlocks: states.filter((state) => state.applied).length, heldBlocks: states.filter((state) => ['held', 'revision_requested'].includes(state.status)).length, unfinishedBlocks: states.filter((state) => !state.applied).length, supported: states.reduce((total, state) => total + state.supported, 0), deferred: states.reduce((total, state) => total + state.deferred, 0), languageWarnings, issues, states };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const jobRoot = process.argv[2];
  if (!jobRoot) throw new Error('Supply the private job directory');
  const manifest = JSON.parse(await readFile(`${jobRoot}/job.json`, 'utf8'));
  const proof = await validateStability(jobRoot, manifest);
  await writeFile(`${jobRoot}/validation.json`, JSON.stringify(proof, null, 2), { mode: 0o600 });
  const { issues, states, ...summary } = proof;
  console.log(JSON.stringify({ ...summary, structuralIssues: issues.length }));
}
