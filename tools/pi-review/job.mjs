import { readFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';

function integer(value, fallback, label, maximum) {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum) throw new Error(`Invalid ${label}`);
  return actual;
}

const overlaps = (first, second) => {
  const path = relative(first, second);
  return !path || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export function parseJob(value, directory) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Job must be an object');
  const allowed = new Set(['chapters', 'minutes', 'limits', 'volumes']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('Unknown job field; credentials do not belong in job JSON');
  if (!Array.isArray(value.volumes) || !value.volumes.length) throw new Error('Supply ordered volumes');
  const seen = new Set();
  const volumes = value.volumes.map((volume, index) => {
    if (!volume || Object.keys(volume).some((key) => !['id', 'input', 'workspace'].includes(key))) throw new Error('Invalid volume');
    const id = integer(volume.id, index + 1, 'volume id', 1000);
    if (seen.has(id) || index && id <= value.volumes[index - 1].id) throw new Error('Volume ids must be unique and ascending');
    seen.add(id);
    if (typeof volume.input !== 'string' || !volume.input.trim()) throw new Error('Supply a UTF-8 input path');
    if (volume.workspace !== undefined && (typeof volume.workspace !== 'string' || !volume.workspace.trim())) throw new Error('Invalid workspace path');
    return { id, input: resolve(directory, volume.input), ...(volume.workspace ? { workspace: resolve(directory, volume.workspace) } : {}) };
  });
  for (const volume of volumes) {
    if (!volume.workspace) continue;
    for (const other of volumes) {
      if (overlaps(volume.workspace, other.input)) throw new Error('Input must be outside workspaces');
      if (other !== volume && other.workspace && (overlaps(volume.workspace, other.workspace) || overlaps(other.workspace, volume.workspace))) throw new Error('Workspaces must not overlap');
    }
  }
  const limits = value.limits ?? {};
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some((key) => !['recallsPerBlock', 'pendingRevisionsPerBlock', 'commands'].includes(key))) throw new Error('Invalid limits');
  return {
    chapters: value.chapters == null ? null : integer(value.chapters, 4, 'chapter count', 10000),
    minutes: integer(value.minutes, value.chapters ? 90 : 240, 'run minutes', 1440),
    limits: {
      recallsPerBlock: integer(limits.recallsPerBlock, 2, 'recall limit', 1000),
      pendingRevisionsPerBlock: integer(limits.pendingRevisionsPerBlock, 3, 'revision limit', 1000),
      commands: integer(limits.commands, 2000, 'command limit', 100000),
    },
    volumes,
  };
}

export async function loadJob(path) {
  if (!path) throw new Error('Usage: node tools/pi-review/run.mjs /private/job.json');
  const absolute = resolve(path);
  return parseJob(JSON.parse(await readFile(absolute, 'utf8')), dirname(absolute));
}
