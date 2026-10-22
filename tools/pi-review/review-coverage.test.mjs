import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreReviewCoverage, sourcePage } from './review-coverage.mjs';

test('resumption credits only successful recorded reads matching the current complete page content', () => {
  const current = { id: 'cs_b0002', createdAt: 'original', proposals: [{ id: 'p0' }, { id: 'p1', value: 'revised' }], reviewNotes: { new: 'read this too' } };
  const entry = (page, isError = false) => ({ type: 'message', message: { role: 'toolResult', isError, content: [{ type: 'text', text: JSON.stringify({ id: current.id, createdAt: current.createdAt, ...page }) }] } });
  const stale = entry({ page: { offset: 1, limit: 1, total: 2 }, proposals: [{ id: 'p1', value: 'old' }] });
  const failed = entry({ page: { offset: 1, limit: 1, total: 2 }, proposals: [current.proposals[1]] }, true);
  const result = restoreReviewCoverage([stale, failed, entry({ page: { offset: 0, limit: 1, total: 2 }, proposals: [current.proposals[0]] }), entry({ page: { offset: 0, limit: 20, total: 1 }, reviewNotes: current.reviewNotes })], current);
  assert.deepEqual([...result.proposals], [0]);
  assert.deepEqual([...result.notes], [0]);
});

test('unbounded source reads cannot earn coverage after SDK line truncation', () => {
  const content = Array.from({ length: 2500 }, (_, index) => `line ${index}`).join('\n');
  assert.throws(() => sourcePage(content, {}, '/private/source'), /bounded sed/);
  assert.equal(sourcePage(content, { start: 1, end: 150 }, '/private/source').output.split('\n').length, 150);
  assert.equal(JSON.parse(sourcePage(content, { count: true }, '/private/source').output).lines, 2500);
});

test('oversized source pages fail before coverage can be credited', () => {
  assert.throws(() => sourcePage('word'.repeat(11000), { start: 1, end: 1 }, '/private/source'), /safe capture limit/);
  assert.equal(sourcePage('short skill', {}, '/private/skill').output, 'short skill');
});
