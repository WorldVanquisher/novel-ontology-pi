import test from 'node:test';
import assert from 'node:assert/strict';
import { replayCommand, replayResult, sanitizeSession } from './replay.mjs';

test('session replay preserves actual tool actions and denials but not sources, secrets or private reports', () => {
  const command = `novel changeset revise /private/novel cs_b0002 --edits '{"removeEntityIds":["SECRET-SOURCE"]}' --reason 'PRIVATE-REASON'`;
  const result = replayCommand(command);
  assert.match(result, /changeset revise.*cs_b0002/);
  assert.ok(!replayCommand('novel search /private/novel alice').includes('alice'));
  assert.ok(!replayCommand('novel fix rename /private/novel char_1 secretname --reason private').includes('secretname'));
  assert.ok(!result.includes('SECRET-SOURCE'));
  assert.ok(!result.includes('PRIVATE-REASON'));
  assert.match(replayResult([{ type: 'text', text: 'Pending revision budget exhausted; hold' }], true), /Pending revision budget exhausted/);
  assert.match(replayResult([{ type: 'text', text: JSON.stringify({ id: 'cs_b0002', proposals: [{ id: 'p1', payload: { text: 'SECRET-SOURCE' } }], reviewNotes: { reason: 'PRIVATE-REASON' } }) }]), /p1/);
  const session = sanitizeSession([
    { type: 'session', version: 3, id: 'session', cwd: '/private/secret' },
    { type: 'message', id: 'm1', message: { role: 'assistant', content: [{ type: 'text', text: 'PRIVATE-REPORT' }, { type: 'thinking', thinking: 'PRIVATE-THINKING' }, { type: 'toolCall', id: 'call1', arguments: { command } }] } },
    { type: 'message', id: 'm2', parentId: 'm1', message: { role: 'toolResult', toolCallId: 'call1', content: [{ type: 'text', text: 'SECRET-SOURCE' }], details: { apiKey: 'SECRET-KEY' } } },
  ]);
  for (const forbidden of ['SECRET-SOURCE', 'SECRET-KEY', 'PRIVATE-REPORT', 'PRIVATE-THINKING', 'PRIVATE-REASON', '/private/secret']) assert.ok(!JSON.stringify(session).includes(forbidden));
  assert.equal(session[2].message.toolCallId, 'call1');
  assert.equal(session[2].parentId, 'm1');
});
