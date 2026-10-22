import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot } from './snapshot.mjs';

async function fixture(run) {
  const runtime = await mkdtemp(join(tmpdir(), 'novel-projection-'));
  const directory = `${runtime}/novel`;
  await mkdir(`${directory}/ontology`, { recursive: true });
  await mkdir(`${directory}/changesets`);
  await writeFile(`${runtime}/chapters.json`, JSON.stringify([{ index: 0, blockId: 'b0001', title: '序章Example', characters: 100 }, { index: 1, blockId: 'b0002', title: '第一章Example', characters: 200 }]));
  try { await run(directory, runtime); } finally { await rm(runtime, { recursive: true }); }
}

const proposals = [
  { id: 'p1', kind: 'upsert_entity', payload: { id: 'char_1', kind: 'Character', names: [{ text: 'Example', kind: 'canonical' }], properties: { secret: 'NOT-PUBLIC' } } },
  { id: 'p2', kind: 'create_event', payload: { id: 'evt_1', chapterIndex: 0, chronologicalOrder: 0, summaryEn: 'An action', evidence: { text: 'PRIVATE-SOURCE-QUOTE' } } },
  { id: 'p3', kind: 'add_relation', payload: { fromId: 'char_1', toId: 'evt_1', type: 'PARTICIPATES_IN' } },
  { id: 'p4', kind: 'set_state_change', payload: { emotions: { happy: 1 } } },
];

test('fresh database contains no sample ontology', () => fixture(async (directory, runtime) => {
  const result = await snapshot(directory, runtime);
  assert.deepEqual(result.counts, { entities: 0, events: 0, scenes: 0, relations: 0, repairs: 0, ghosts: 0 });
  assert.equal(result.world.interiors.chapter_0.nodes.length, 0);
  assert.equal(result.status, 'idle');
  assert.equal(result.gates.length, 0);
}));

test('held proposals become real ghost records without exposing payloads or quotes', () => fixture(async (directory, runtime) => {
  await writeFile(`${directory}/changesets/cs_b0001.json`, JSON.stringify({ id: 'cs_b0001', blockId: 'b0001', status: 'held', proposals }));
  const result = await snapshot(directory, runtime);
  assert.equal(result.world.interiors.chapter_0.nodes.length, 2);
  assert.equal(result.world.interiors.chapter_0.nodes[0].kind, 'character');
  assert.ok(result.world.interiors.chapter_0.nodes.every((node) => node.state === 'held'));
  assert.equal(result.world.interiors.chapter_0.edges.length, 1);
  assert.equal(result.gates[0].status, 'held');
  assert.ok(!JSON.stringify(result).includes('PRIVATE-SOURCE-QUOTE'));
  assert.ok(!JSON.stringify(result).includes('NOT-PUBLIC'));
}));

test('application with deferred proposals is not falsely merged and removed proposals do not reappear', () => fixture(async (directory, runtime) => {
  await writeFile(`${directory}/changesets/cs_b0001.json`, JSON.stringify({ id: 'cs_b0001', blockId: 'b0001', status: 'approved', proposals }));
  await writeFile(`${directory}/ontology/entities.jsonl`, `${JSON.stringify(proposals[0].payload)}\n`);
  await writeFile(`${directory}/events.jsonl`, `${JSON.stringify({ id: '1', timestamp: new Date().toISOString(), event: { type: 'changeset.applied', changesetId: 'cs_b0001', processed: 4, unsupportedProposalIds: ['p4'] } })}\n`);
  const result = await snapshot(directory, runtime);
  assert.equal(result.gates[0].status, 'applied');
  assert.equal(result.gates[0].deferred, 1);
  assert.deepEqual(result.world.interiors.chapter_0.nodes.map((node) => node.id), ['char_1']);
  assert.equal(result.world.interiors.chapter_0.nodes[0].state, 'canon');
  assert.equal(result.world.interiors.chapter_0.edges.length, 0);
}));

test('Jev scene/dialogue decisions and name candidates render before any ChangeSet or ontology write', () => fixture(async (directory, runtime) => {
  await mkdir(`${directory}/working`);
  const file = `${directory}/working/b0001.json`;
  const draft = {
    version: 1, blockId: 'b0001', chapterIndex: 0, stage: 'miniloop', patchId: 'name-detector', updatedAt: new Date().toISOString(),
    proposals: [{ id: 'candidate-1', kind: 'upsert_entity', payload: { candidateName: 'Example', needsExtraction: true } }],
    sceneSpans: [['b0000_s0001', 'b0000_s0002']], dialogueUnits: [['b0000_s0002']], turns: [], completedScenes: 0, totalScenes: 1,
  };
  await writeFile(file, JSON.stringify(draft));
  const first = await snapshot(directory, runtime);
  const interior = first.world.interiors.chapter_0;
  assert.equal(first.counts.entities, 0);
  assert.equal(first.counts.events, 0);
  assert.equal(first.counts.ghosts, 3);
  assert.equal(first.gates.length, 0);
  assert.deepEqual(interior.nodes.map((node) => node.kind), ['character', 'scene', 'dialogue']);
  assert.ok(interior.nodes.every((node) => node.state === 'proposed' && node.parent === 'chapter_0'));
  assert.ok(interior.edges.some((edge) => edge.kind === 'contains'));
  assert.ok(first.world.laneNodes.some((node) => node.id.startsWith('draft:')));
  await writeFile(file, JSON.stringify({ ...draft, proposals: [], dialogueUnits: [] }));
  const revised = await snapshot(directory, runtime);
  assert.equal(revised.counts.ghosts, 1);
  assert.equal(revised.world.interiors.chapter_0.nodes[0].id, interior.nodes.find((node) => node.kind === 'scene').id);
}));

test('full-volume projection groups multiple blocks per chapter and isolates volume activity', () => fixture(async (directory, runtime) => {
  await writeFile(`${runtime}/chapters.json`, JSON.stringify([
    { index: 0, title: '序章', blockIds: ['b0001'], characters: 10 },
    { index: 1, title: '第一章', blockIds: ['b0002', 'b0003'], characters: 20 },
    { index: 2, title: '第二章', blockIds: ['b0004'], characters: 30 },
  ]));
  for (const [blockId, chapterIndex] of [['b0002', 1], ['b0003', 1], ['b0004', 2]]) {
    await writeFile(`${directory}/changesets/cs_${blockId}.json`, JSON.stringify({
      id: `cs_${blockId}`, blockId, status: 'held', proposals: [
        { id: `p_${blockId}`, kind: 'create_event', payload: { id: `evt_${blockId}`, chapterIndex, chronologicalOrder: 1, summaryEn: '测试', evidence: { text: 'PRIVATE-SOURCE-QUOTE' } } },
      ],
    }));
  }
  await writeFile(`${directory}/events.jsonl`, JSON.stringify({ id: 'started', timestamp: '2026-10-22T00:00:00Z', event: { type: 'block.started', blockId: 'b0003' } }) + '\n');
  await writeFile(`${runtime}/pi-events.jsonl`, [
    { id: 'pi1', volume: 1, timestamp: '2026-10-22T00:00:00Z', type: 'pi.status', status: 'working', label: 'Volume one active' },
    { id: 'pi2', volume: 2, timestamp: '2026-10-22T00:00:01Z', type: 'pi.status', status: 'error', label: 'Other-volume activity' },
  ].map(JSON.stringify).join('\n'));
  const result = await snapshot(directory, runtime, { volume: 1 });
  assert.equal(result.world.interiors.chapter_1.nodes.length, 2);
  assert.equal(result.world.interiors.chapter_2.nodes.length, 1);
  assert.equal(result.world.laneEdges.filter((edge) => edge.kind === 'flow').length, 2);
  assert.equal(result.gates.length, 3);
  assert.equal(result.workSite, 'chapter_1');
  assert.equal(result.expectedBlocks, 4);
  assert.equal(result.status, 'working');
  assert.equal(result.label, 'Volume one active');
  assert.ok(!JSON.stringify(result).includes('PRIVATE-SOURCE-QUOTE'));
  assert.ok(!JSON.stringify(result).includes('Other-volume activity'));
  const stopped = await snapshot(directory, runtime, { volume: 1, jobStatus: true });
  assert.equal(stopped.status, 'error');
}));

test('applied blocks do not falsely mark a still-working Pi final check complete', () => fixture(async (directory, runtime) => {
  const records = [];
  for (const blockId of ['b0001', 'b0002']) {
    await writeFile(`${directory}/changesets/cs_${blockId}.json`, JSON.stringify({ id: `cs_${blockId}`, blockId, status: 'approved', proposals: [] }));
    records.push({ id: blockId, timestamp: '2026-10-22T00:00:00Z', event: { type: 'changeset.applied', changesetId: `cs_${blockId}`, processed: 0, unsupportedProposalIds: [] } });
  }
  await writeFile(`${directory}/events.jsonl`, records.map(JSON.stringify).join('\n'));
  const writeState = (status) => writeFile(`${runtime}/pi-events.jsonl`, JSON.stringify({ id: 'pi', volume: 1, timestamp: '2026-10-22T00:00:01Z', type: 'pi.status', status, label: 'Pi status' }) + '\n');
  await writeState('working');
  const working = await snapshot(directory, runtime, { volume: 1, activeVolume: 1 });
  assert.equal(working.status, 'working');
  assert.match(working.label, /2\/2 blocks applied · Pi final checks/);
  await writeState('complete');
  assert.equal((await snapshot(directory, runtime, { volume: 1, activeVolume: 1 })).status, 'complete');
}));
