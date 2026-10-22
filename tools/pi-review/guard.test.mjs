import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize as authorizeScoped } from './guard.mjs';
const novel = '/private/review/novel';
const input = '/private/review/source.txt';
const skill = '/private/review/SKILL.md';
const chapterOne = '/private/review/b0002.txt';
const defaultScope = { novel, input, skill, sourcePaths: [skill, chapterOne], blockIds: ['b0001', 'b0002'], maxBlocks: 2 };
const authorize = (command, scope = defaultScope) => authorizeScoped(command, scope);

test('permits only scoped, explicit CLI operations', () => {
  assert.equal(authorize(`novel ingest '${novel}' '${input}' --max-blocks 2 --block-size 24000`).kind, 'cli');
  assert.equal(authorize(`novel fix merge '${novel}' loc_1 loc_2 --reason '同一条街; confirmed in source'`).args[3], 'loc_1');
  assert.equal(authorize(`cat '${skill}'`).kind, 'read');
  assert.equal(authorize(`novel query '${novel}' 'MATCH (entity:Character) RETURN entity.id'`).kind, 'cli');
  assert.equal(authorize(`novel changeset show '${novel}' cs_b0001 --offset 20 --limit 20`).kind, 'cli');
  assert.equal(authorize(`sed -n '151,300p' '${chapterOne}'`).start, 151);
  assert.equal(authorize(`wc -l '${chapterOne}'`).count, true);
  assert.equal(authorize(`novel fix correct '${novel}' --block b0001 --key extraction:constraints --value '{"distinctNames":[["甲","乙"]]}' --reason '原文中是不同人物'`).kind, 'cli');
  assert.equal(authorize(`novel recall '${novel}' b0001`).kind, 'cli');
  assert.equal(authorize(`novel changeset revise '${novel}' cs_b0002 --edits '{"sanitizeTypes":true}' --reason '类型检查'`).kind, 'cli');
});

test('rejects shell injection, arbitrary reads, paths, writes, and gate bypass', () => {
  for (const command of [
    'env', 'cat /etc/passwd', `novel changeset approve /tmp/other cs_b0001`,
    `novel ingest '${novel}' '${input}' --auto-approve`,
    `novel config; env`, `novel config | cat`, 'novel config\nenv',
    'novel config $(env)', 'novel config > /tmp/key',
    `novel query '${novel}' 'MATCH (entity) DELETE entity'`,
    `novel graph build '${novel}/ontology' /tmp/other`,
    `novel changeset approve '${novel}' cs_b0003`,
    `sed -n '1,100p' /etc/passwd`, `sed -n '1,300p' '${chapterOne}'`,
    `novel changeset show '${novel}' cs_b0001 --output /tmp/leak`,
    `novel changeset show '${novel}' cs_b0001`, `novel changeset show '${novel}' cs_b0001 --limit 100`,
    `novel recall '${novel}' b0003`,
    `novel fix correct '${novel}' --block b0003 --key extraction:constraints --value '{}' --reason 'test'`,
    `novel fix correct '${novel}' --block b0001 --key key --value '{}' --reason 'test' --output /tmp/leak`,
    `novel changeset revise '${novel}' cs_b0003 --edits '{}' --reason 'test'`,
    `novel changeset revise '${novel}' cs_b0002 --edits '{}' --reason 'test' --output /tmp/leak`,
  ]) assert.throws(() => authorize(command), command);
});

test('full-volume scopes permit only the current block in the selected workspace', () => {
  const scope = { novel: '/tmp/authorized-volume-2', input: '/tmp/authorized-volume-2.txt', skill, sourcePaths: [skill, '/tmp/current-b0009.txt'], blockIds: ['b0009'], maxBlocks: 9 };
  assert.equal(authorize("novel ingest /tmp/authorized-volume-2 /tmp/authorized-volume-2.txt --max-blocks 9 --block-size 24000", scope).kind, 'cli');
  assert.equal(authorize("novel changeset show /tmp/authorized-volume-2 cs_b0009 --offset 0 --limit 10", scope).kind, 'cli');
  assert.equal(authorize("novel recall /tmp/authorized-volume-2 b0009", scope).kind, 'cli');
  for (const command of [
    'novel changeset approve /tmp/authorized-volume-2 cs_b0008',
    'novel changeset approve /tmp/other-volume cs_b0009',
    'novel ingest /tmp/authorized-volume-2 /tmp/authorized-volume-2.txt --max-blocks 10 --block-size 24000',
    'novel recall /tmp/authorized-volume-2 b0001',
    'cat /tmp/old-b0008.txt',
    "novel fix correct /tmp/authorized-volume-2 --block b0009 --key x --key y --value '{}' --reason test",
  ]) assert.throws(() => authorize(command, scope), command);
});
