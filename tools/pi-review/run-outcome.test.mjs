import test from 'node:test';
import assert from 'node:assert/strict';
import { runOutcome } from './run-outcome.mjs';

test('a hold is a pause with zero applications, never a completed run or fabricated deferral', () => {
  const result = runOutcome([{ id: 'cs_b0001', status: 'held' }], []);
  assert.equal(result.status, 'review');
  assert.match(result.label, /paused.*cs_b0001 held.*0\/2 chapters applied/);
  assert.ok(!result.label.includes('complete'));
  assert.equal(result.deferred, 0);
});

test('only recorded applications count and actual unsupported proposals remain explicit', () => {
  const changesets = [{ id: 'cs_b0001', status: 'approved' }, { id: 'cs_b0002', status: 'approved' }];
  const records = [{ event: { type: 'changeset.applied', changesetId: 'cs_b0001', unsupportedProposalIds: ['p1'] } }];
  assert.equal(runOutcome(changesets, records).status, 'review');
  records.push({ event: { type: 'changeset.applied', changesetId: 'cs_b0002', unsupportedProposalIds: [] } });
  const result = runOutcome(changesets, records);
  assert.equal(result.status, 'complete');
  assert.equal(result.deferred, 1);
  assert.match(result.label, /2\/2 chapters applied.*1 proposals deferred/);
});
