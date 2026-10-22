import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';

export const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export const root = resolve(process.env.NOVEL_REVIEW_HOME ?? `${repo}/.pi-review`) + sep;
export const novel = `${root}runtime/novel`;
export const cli = `${repo}/dist/src/cli.js`;
export const skill = `${repo}/skills/novel-ontology/SKILL.md`;
export const agentEvents = `${root}runtime/pi-events.jsonl`;
