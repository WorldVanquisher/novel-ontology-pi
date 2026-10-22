import test from 'node:test';
import assert from 'node:assert/strict';
import { structuralIssues, nonCjkNarrative } from './validate-stability.mjs';

test('stability checks reject dangling, mistyped and contradictory references without inferring replacements', () => {
  const entities = [{ id: 'char_1', kind: 'Character' }, { id: 'org_1', kind: 'Organization' }];
  assert.deepEqual(structuralIssues(entities, [], [], []), []);
  const issues = structuralIssues(entities, [{ id: 'evt_1', primaryActors: ['org_1'] }], [{ id: 'scene_1', charactersPresent: ['char_1'], charactersMentioned: ['char_1'], locationId: 'org_1', turns: [] }], [{ fromId: 'char_1', toId: 'missing' }]);
  assert.deepEqual(issues.map((issue) => issue.code).sort(), ['dangling-relation', 'invalid-character-reference', 'invalid-location-reference', 'overlapping-presence-and-mention']);
});

test('source-language heuristic distinguishes foreign prose from wordless punctuation', () => {
  assert.equal(nonCjkNarrative('……'), false);
  assert.equal(nonCjkNarrative('甲保持沉默。'), false);
  assert.equal(nonCjkNarrative('The character remains silent.'), true);
});
