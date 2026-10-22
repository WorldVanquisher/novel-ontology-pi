import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('pinned Pi exporter renders only the sanitized session and marks costs unpriced', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-replay-'));
  const previous = process.env.NOVEL_REVIEW_HOME;
  process.env.NOVEL_REVIEW_HOME = home;
  try {
    const attempt = 'stability-2026-10-22T00-00-00-000Z';
    const directory = join(home, 'runtime', attempt, 'sessions');
    await mkdir(directory, { recursive: true });
    const entries = [
      { type: 'session', version: 3, id: 'synthetic', timestamp: '2026-10-22T00:00:00Z', cwd: '/private/source-location' },
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-10-22T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'PRIVATE-SOURCE-TEXT' }], timestamp: 1 } },
    ];
    await writeFile(join(directory, 'session.jsonl'), entries.map(JSON.stringify).join('\n') + '\n');
    const { replayHtml } = await import('./replay.mjs');
    const { html, hashes } = await replayHtml(attempt);
    assert.match(html, /Source-redacted session replay/);
    assert.match(html, /Not estimated/);
    assert.ok(hashes.length > 0);
    assert.ok(!html.includes('PRIVATE-SOURCE-TEXT'));
    assert.ok(!html.includes('/private/source-location'));
    assert.ok(!html.includes('${totalCost.toFixed(3)}'));
  } finally {
    if (previous === undefined) delete process.env.NOVEL_REVIEW_HOME;
    else process.env.NOVEL_REVIEW_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
