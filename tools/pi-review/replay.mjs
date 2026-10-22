import { readFile, readdir, mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { root } from './config.mjs';
import { tokenize } from './guard.mjs';

const numberFields = ['totalProposals', 'totalNotes', 'applied', 'processed', 'deferred', 'dropped', 'normalized', 'pinsHonored', 'proposals'];
const safeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
const numericObject = (value) => Object.fromEntries(Object.entries(value ?? {}).filter(([key, item]) => /^[a-zA-Z_]+$/.test(key) && typeof item === 'number' && Number.isFinite(item)));

export function replayCommand(command) {
  let tokens;
  try { tokens = tokenize(command); } catch { return '[Malformed command: quoting or shell syntax rejected]'; }
  if (tokens[0] !== 'novel') return ['cat', 'sed', 'wc'].includes(tokens[0]) ? `${tokens[0]} [private skill/source page]` : '[Unsupported command withheld]';
  const parts = ['novel'];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (['--reason', '--edits', '--value', '--key'].includes(token)) { parts.push(token, '[private argument]'); index++; }
    else if (token.startsWith('/') || token.includes('/')) parts.push('[workspace/input]');
    else if (index === 1 && ['help', 'config', 'init', 'ingest', 'changeset', 'fix', 'match', 'recall', 'query', 'search', 'timeline', 'graph'].includes(token)) parts.push(token);
    else if (index === 2 && ['changeset', 'fix', 'timeline', 'graph'].includes(tokens[1]) && ['list', 'show', 'approve', 'hold', 'revise', 'merge', 'rename', 'add-form', 'relate', 'unrelate', 'remove-entity', 'remove-event', 'correct', 'corrections', 'build'].includes(token)) parts.push(token);
    else if (/^(--[a-z-]+|cs_b\d+|b\d+|(?:char|loc|org|item|concept|evt|scene)_\d+|\d+)$/.test(token)) parts.push(token);
    else parts.push('[private argument]');
  }
  return parts.join(' ');
}

export function replayResult(content, isError) {
  const output = (content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  const denial = [
    [/Recall budget exhausted/i, 'Recall budget exhausted'],
    [/Pending revision budget exhausted/i, 'Pending revision budget exhausted'],
    [/Read ALL proposal and note pages/i, 'Approval denied: incomplete current-revision review'],
    [/Read the skill and every current-block evidence line/i, 'Approval denied: incomplete skill/source coverage'],
    [/already approved|apply twice|already applied/i, 'Applied packet protected against replay'],
    [/outside.*allowlist|outside.*scoped CLI|Shell operators|Unclosed quote|One command per call/i, 'Command syntax or scoped allowlist rejection'],
    [/Earlier volumes must pass/i, 'Earlier-volume merge gates unresolved'],
    [/No entity [a-z_0-9]+/i, 'Entity not found in canonical ontology'],
    [/Output too large|safe capture limit/i, 'Output too large: review page not credited'],
    [/budget exhausted|Run window/i, 'Run budget exhausted'],
  ].find(([pattern]) => pattern.test(output));
  if (denial) return JSON.stringify({ error: denial[1], recordedError: !!isError });
  let result;
  try { result = JSON.parse(output); } catch { return JSON.stringify({ output: isError ? 'Tool error; raw output retained privately' : 'Private source or textual output withheld', recordedError: !!isError }); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return JSON.stringify({ output: 'Private structured output withheld', recordedError: !!isError });
  const projected = { recordedError: !!isError };
  for (const field of ['id', 'blockId', 'status']) if (safeId(result[field])) projected[field] = result[field];
  for (const field of numberFields) if (typeof result[field] === 'number') projected[field] = result[field];
  if (result.page) projected.page = numericObject(result.page);
  if (result.counts) projected.counts = numericObject(result.counts);
  if (Array.isArray(result.proposals)) projected.proposalIds = result.proposals.map((proposal) => safeId(proposal.id)).filter(Boolean);
  if (Array.isArray(result.changesets)) projected.packets = result.changesets.map((packet) => ({ id: safeId(packet.id), status: safeId(packet.status) }));
  return JSON.stringify(projected);
}

export function sanitizeSession(entries) {
  return entries.flatMap((entry) => {
    const base = { type: entry.type, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp };
    if (entry.type === 'session') return [{ ...base, version: entry.version, cwd: '/private/novel-runtime' }];
    if (entry.type === 'model_change') return [{ ...base, provider: safeId(entry.provider), modelId: safeId(entry.modelId) }];
    if (entry.type === 'thinking_level_change') return [{ ...base, thinkingLevel: safeId(entry.thinkingLevel) }];
    if (entry.type === 'compaction') return [{ ...base, summary: 'Context compacted; private summary withheld.', firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore }];
    if (entry.type !== 'message') return [];
    const message = entry.message;
    const projected = { role: message.role, timestamp: message.timestamp };
    if (message.role === 'user') projected.content = [{ type: 'text', text: 'Task instruction (private transcript retained locally).' }];
    else if (message.role === 'assistant') {
      Object.assign(projected, { api: safeId(message.api), provider: safeId(message.provider), model: safeId(message.model), stopReason: safeId(message.stopReason) });
      if (message.usage) projected.usage = { ...numericObject(message.usage), cost: numericObject(message.usage.cost) };
      projected.content = (message.content ?? []).filter((part) => part.type === 'toolCall').map((part) => ({ type: 'toolCall', id: part.id, name: 'bash', arguments: { command: replayCommand(part.arguments?.command ?? '') } }));
      if (!projected.content.length) projected.content = [{ type: 'text', text: `Pi response · stop: ${safeId(message.stopReason) ?? 'recorded'} · narrative report retained privately.` }];
    } else if (message.role === 'toolResult') Object.assign(projected, { toolCallId: message.toolCallId, toolName: 'bash', isError: !!message.isError, durationMs: message.durationMs, content: [{ type: 'text', text: replayResult(message.content, message.isError) }] });
    else return [];
    return [{ ...base, message: projected }];
  });
}

export async function replayHtml(attemptName) {
  const { exportFromFile } = await import(new URL('./core/export-html/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
  const directory = `${root}runtime`;
  const attempts = (await readdir(directory)).filter((name) => /^(full-loop|stability)-\d{4}-[\dTZ-]+$/.test(name)).sort((first, second) => second.replace(/^(full-loop|stability)-/, '').localeCompare(first.replace(/^(full-loop|stability)-/, '')));
  if (attemptName && !attempts.includes(attemptName)) throw new Error('Unknown replay attempt');
  let selected;
  for (const attempt of attempts) {
    if (attemptName && attempt !== attemptName) continue;
    const sessions = await readdir(join(directory, attempt, 'sessions')).catch(() => []);
    const file = sessions.filter((name) => name.endsWith('.jsonl')).sort().at(-1);
    if (file) { selected = { attempt, file }; break; }
  }
  if (!selected) throw new Error('No session recorded');
  const raw = await readFile(join(directory, selected.attempt, 'sessions', selected.file), 'utf8');
  const entries = raw.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const output = join(directory, selected.attempt, 'replay');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const input = join(output, 'sanitized.jsonl');
  await writeFile(input, sanitizeSession(entries).map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
  const path = await exportFromFile(input, { outputPath: join(output, 'index.html'), themeName: 'dark' });
  await chmod(path, 0o600);
  const links = attempts.map((attempt) => `<a href="?attempt=${attempt}">${attempt}</a>`).join(' · ');
  const html = (await readFile(path, 'utf8'))
    .replace('<title>Session Export</title>', '<title>Pi session replay — source-redacted</title>')
    .replace('<body>', `<body><div style="padding:12px;color:#ddd;background:#191d25;font:12px system-ui;overflow-wrap:anywhere"><b>Source-redacted session replay</b> · actual commands, result metadata and guard failures. Source text, narrative reports and private arguments stay local. Token counts cover Pi, not nested CLI models. API cost is not priced here.<br>Reload for the latest snapshot. No source text or live chat is included.<br>${links}</div>`)
    .replace('${totalCost.toFixed(3)}', 'Not estimated');
  const hashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
  return { html, hashes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { html } = await replayHtml(process.argv[2]);
  const output = process.argv[3];
  if (!output) throw new Error('Supply attempt name and a private output HTML path');
  await writeFile(output, html, { mode: 0o600, flag: 'wx' });
  console.log('Source-redacted replay exported. Inspect before sharing.');
}
