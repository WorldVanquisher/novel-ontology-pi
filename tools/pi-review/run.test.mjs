import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const run = (job, home) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [runner, job], {
    env: { ...process.env, NOVEL_REVIEW_HOME: home, WORK_LLM_API_KEY: '', TYPESAFE_API_KEY: '', NOVEL_SECRETS_DIR: join(home, 'no-secrets') },
    stdio: 'ignore', timeout: 15000,
  });
  child.once('error', reject);
  child.once('close', resolve);
});

test('portable runner stops before any paid work without a key and releases its locks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-review-'));
  try {
    await writeFile(join(directory, 'source.txt'), 'Chapter 0\n\nA short synthetic test sentence.');
    const job = join(directory, 'job.json');
    await writeFile(job, JSON.stringify({ chapters: 1, volumes: [{ input: 'source.txt', workspace: 'novel' }] }));
    const home = join(directory, 'home');
    assert.equal(await run(job, home), 1);
    await assert.rejects(access(join(home, 'runtime/full-loop.lock')));
    await assert.rejects(access(join(directory, 'novel.pi-review.lock')));
    await assert.rejects(access(join(directory, 'novel')));
    const attempts = (await readdir(join(home, 'runtime'))).filter((name) => name.startsWith('stability-'));
    const error = JSON.parse(await readFile(join(home, 'runtime', attempts[0], 'error.json'), 'utf8'));
    assert.match(error.reason, /WORK_LLM_API_KEY is required/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an existing writer lock is never deleted or bypassed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-review-'));
  try {
    const home = join(directory, 'home');
    await mkdir(join(home, 'runtime'), { recursive: true });
    const lock = join(home, 'runtime/full-loop.lock');
    await writeFile(lock, 'existing-writer');
    const job = join(directory, 'job.json');
    await writeFile(job, JSON.stringify({ volumes: [{ input: 'unused.txt' }] }));
    assert.equal(await run(job, home), 1);
    assert.equal(await readFile(lock, 'utf8'), 'existing-writer');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
