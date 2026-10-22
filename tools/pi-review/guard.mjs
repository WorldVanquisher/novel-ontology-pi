export function tokenize(command) {
  const tokens = [];
  let value = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      else if (character === '\\' && quote === '"') {
        if (++index >= command.length) throw new Error('Unclosed escape');
        value += command[index];
      } else value += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (character === '\\') {
      if (++index >= command.length) throw new Error('Unclosed escape');
      value += command[index];
      started = true;
    } else if (/\s/.test(character)) {
      if (character === '\n' || character === '\r') throw new Error('One command per call');
      if (started) tokens.push(value);
      value = '';
      started = false;
    } else {
      if (/[;&|<>`$(){}*?\[\]#]/.test(character)) throw new Error('Shell operators and expansions are disabled');
      value += character;
      started = true;
    }
  }
  if (quote) throw new Error('Unclosed quote');
  if (started) tokens.push(value);
  return tokens;
}

export function authorize(command, scope) {
  const { novel, input, skill, sourcePaths, blockIds, maxBlocks } = scope;
  const tokens = tokenize(command);
  if (tokens[0] === 'wc' && tokens[1] === '-l' && tokens.length === 3 && sourcePaths.includes(tokens[2])) {
    return { kind: 'read', path: tokens[2], count: true, label: 'Count source lines' };
  }
  if (tokens[0] === 'sed' && tokens[1] === '-n' && tokens.length === 4 && sourcePaths.includes(tokens[3])) {
    const range = tokens[2].match(/^(\d+),(\d+)p$/);
    if (!range || Number(range[1]) < 1 || Number(range[2]) < Number(range[1]) || Number(range[2]) - Number(range[1]) >= 150) throw new Error('Source reads allow 1–150 lines per page');
    return { kind: 'read', path: tokens[3], start: Number(range[1]), end: Number(range[2]), label: `Read source lines ${range[1]}–${range[2]}` };
  }
  if (tokens[0] === 'cat' && tokens.length === 2 && sourcePaths.includes(tokens[1])) {
    return { kind: 'read', path: tokens[1], label: tokens[1] === skill ? 'Read ontology skill' : 'Read supplied source/reference' };
  }
  if (tokens.shift() !== 'novel') throw new Error('Use only novel commands or cat of the supplied skill/source block');
  const [verb, operation] = tokens;
  let valid = false;
  if (verb === 'help' || verb === 'config') valid = tokens.length === 1;
  if (verb === 'init') valid = tokens.length === 2 && operation === novel;
  if (verb === 'ingest') {
    const options = tokens.slice(3);
    valid = operation === novel && tokens[2] === input;
    const seen = new Set();
    for (let index = 0; index < options.length; index += 2) {
      const option = options[index];
      if (seen.has(option)) valid = false;
      seen.add(option);
      if (option === '--block-size') valid &&= options[index + 1] === '24000';
      else if (option === '--max-blocks') valid &&= /^\d+$/.test(options[index + 1] ?? '') && Number(options[index + 1]) >= 1 && Number(options[index + 1]) <= maxBlocks;
      else valid = false;
    }
  }
  if (verb === 'changeset') valid = tokens[2] === novel && (
    (operation === 'list' && tokens.length === 3) ||
    (['show', 'approve', 'hold'].includes(operation) && tokens.length === 4 && blockIds.map((id) => `cs_${id}`).includes(tokens[3]))
  );
  if (verb === 'changeset' && operation === 'show' && tokens[2] === novel && blockIds.map((id) => `cs_${id}`).includes(tokens[3])) {
    const options = tokens.slice(4);
    valid = options.length > 0;
    for (let index = 0; index < options.length; index++) {
      if (['--summary', '--notes'].includes(options[index])) continue;
      if (['--offset', '--limit'].includes(options[index]) && /^\d+$/.test(options[index + 1] ?? '')) { index++; continue; }
      valid = false;
    }
    const limitIndex = options.indexOf('--limit');
    if (limitIndex >= 0 && (Number(options[limitIndex + 1]) < 1 || Number(options[limitIndex + 1]) > 20)) valid = false;
  }
  if (verb === 'match') valid = tokens.length === 4 && operation === novel && tokens[2] === '--changeset' && blockIds.map((id) => `cs_${id}`).includes(tokens[3]);
  if (verb === 'changeset' && operation === 'revise') {
    const options = tokens.slice(4);
    valid = tokens[2] === novel && blockIds.map((id) => `cs_${id}`).includes(tokens[3]) && options.length === 4 && new Set([options[0], options[2]]).size === 2 && [options[0], options[2]].every((flag) => ['--edits', '--reason'].includes(flag)) && !!options[1] && !!options[3];
  }
  if (verb === 'fix') {
    const operations = new Set(['merge', 'rename', 'add-form', 'relate', 'unrelate', 'remove-entity', 'remove-event']);
    valid = operations.has(operation) && tokens[2] === novel && tokens.includes('--reason') && tokens.length <= 12;
    const options = tokens.slice(3).filter((token) => token.startsWith('--'));
    valid &&= options.every((token) => ['--reason', '--kind'].includes(token));
    if (operation === 'corrections') valid = tokens.length === 3 && tokens[2] === novel;
    if (operation === 'correct') {
      const flags = tokens.slice(3);
      const values = new Map();
      for (let index = 0; index < flags.length; index += 2) {
        if (!['--block', '--key', '--value', '--reason'].includes(flags[index]) || values.has(flags[index]) || !flags[index + 1]) throw new Error('Correction requires unique --block, --key, --value, and --reason options');
        values.set(flags[index], flags[index + 1]);
      }
      valid = tokens[2] === novel && flags.length === 8 && values.size === 4 && ['--block', '--key', '--value', '--reason'].every((key) => values.has(key)) && blockIds.includes(values.get('--block'));
    }
  }
  if (verb === 'recall') valid = operation === novel && tokens.length === 3 && blockIds.includes(tokens[2]);
  if (verb === 'graph') valid = operation === 'build' && tokens.length === 3 && tokens[2] === `${novel}/ontology`;
  if (verb === 'query') valid = operation === novel && tokens.length === 3 && /^\s*MATCH\b/i.test(tokens[2]) && !/\b(CREATE|MERGE|SET|DELETE|DROP|ALTER|COPY|LOAD|INSTALL|ATTACH|CALL|REMOVE)\b|;/i.test(tokens[2]);
  if (verb === 'search') valid = operation === novel && tokens.length === 3;
  if (verb === 'timeline') valid = operation === 'list' && tokens.length === 3 && tokens[2] === novel;
  if (!valid) throw new Error('Command outside this block/workspace CLI allowlist; no shell, direct file writes, credential access, or auto-approve');
  return { kind: 'cli', args: tokens, label: `novel ${verb}${['changeset', 'fix', 'graph', 'timeline'].includes(verb) ? ` ${operation}` : ''}` };
}
