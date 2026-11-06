import type { ConversationSegment } from './conversation';

const operationNames: Readonly<Record<string, readonly [string, string]>> = {
  read_file: ['file read', 'file reads'],
  memory_get: ['file read', 'file reads'],
  file_search: ['search', 'searches'],
  grep_search: ['search', 'searches'],
  memory_search: ['search', 'searches'],
  exec: ['command', 'commands'],
  write_file: ['file change', 'file changes'],
  edit_file: ['file change', 'file changes'],
  apply_patch: ['file change', 'file changes'],
  memory_write: ['file change', 'file changes'],
  web_fetch: ['web fetch', 'web fetches'],
  list_dir: ['directory listing', 'directory listings'],
  process: ['process operation', 'process operations'],
  task: ['subagent task', 'subagent tasks'],
};

export function toolGroupTitle(segments: readonly ConversationSegment[]): string {
  const counts = new Map<string, { count: number; plural: string }>();
  let other = 0;
  for (const segment of segments) {
    if (segment.type !== 'tool_call') continue;
    const names = Object.hasOwn(operationNames, segment.name ?? '')
      ? operationNames[segment.name ?? '']
      : undefined;
    if (!names) {
      other++;
      continue;
    }
    const [singular, plural] = names;
    const previous = counts.get(singular);
    if (previous) previous.count++;
    else counts.set(singular, { count: 1, plural });
  }
  const parts: string[] = [];
  for (const [singular, { count, plural }] of counts) {
    if (parts.length < 3) parts.push(`${count} ${count === 1 ? singular : plural}`);
    else other += count;
  }
  if (other) parts.push(`${other} other ${other === 1 ? 'operation' : 'operations'}`);
  return parts.join(', ');
}

function isInput(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function pathName(path: string): string {
  if (/^[a-z]:[\\/]+$/i.test(path)) return path;
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}

function readRange(start: unknown, end: unknown): string | undefined {
  if ((start !== undefined && !positiveInteger(start))
    || (end !== undefined && !positiveInteger(end))) return undefined;
  if (start === undefined && end === undefined) return '';
  if (end === undefined) return `, from line ${start}`;
  const first = start ?? 1;
  if (first > end) return undefined;
  return first === end ? `, line ${first}` : `, lines ${first}\u2013${end}`;
}

export function toolDisplayTitle(segment: ConversationSegment): string {
  const fallback = segment.name ?? 'Tool';
  const input = segment.input;
  if (!isInput(input)) return fallback;
  const file = nonEmpty(input.path) ? pathName(input.path) : undefined;
  switch (segment.name) {
    case 'read_file': {
      const range = readRange(input.startLine, input.endLine);
      return file && range !== undefined ? `Read ${file}${range}` : fallback;
    }
    case 'memory_get': {
      if (input.lines !== undefined && !positiveInteger(input.lines)) return fallback;
      const end = positiveInteger(input.from) && positiveInteger(input.lines)
        ? input.from + (input.lines - 1) : undefined;
      const range = readRange(input.from, end);
      return file && range !== undefined ? `Read memory ${file}${range}` : fallback;
    }
    case 'list_dir': return file ? `List ${file}` : fallback;
    case 'write_file': return file ? `Write ${file}` : fallback;
    case 'edit_file': return file ? `Edit ${file}` : fallback;
    case 'memory_write':
      if (input.mode === undefined || input.mode === 'append') {
        return file ? `Append to memory ${file}` : fallback;
      }
      return input.mode === 'overwrite' && file ? `Write memory ${file}` : fallback;
    case 'file_search':
      return nonEmpty(input.query) ? `Find files matching "${input.query}"` : fallback;
    case 'grep_search':
      return nonEmpty(input.query) ? `Search for "${input.query}"` : fallback;
    case 'memory_search':
      return nonEmpty(input.query) ? `Search memory for "${input.query}"` : fallback;
    case 'exec': return nonEmpty(input.command) ? `Run ${input.command}` : fallback;
    case 'task': return nonEmpty(input.description) ? input.description : fallback;
    case 'apply_patch': return nonEmpty(input.input) ? 'Apply patch' : fallback;
    case 'process':
      if (input.action === 'list') return 'List background processes';
      if (!nonEmpty(input.runId)) return fallback;
      switch (input.action) {
        case 'status': return `Check process status \u00b7 ${input.runId}`;
        case 'log': return `Read process logs \u00b7 ${input.runId}`;
        case 'kill': return `Stop process \u00b7 ${input.runId}`;
        default: return fallback;
      }
    case 'web_fetch': {
      if (!nonEmpty(input.url)) return fallback;
      let url: URL;
      try {
        url = new URL(input.url);
      } catch (error) {
        if (error instanceof TypeError) return fallback;
        throw error;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
      const parts = url.pathname.split('/').filter(Boolean);
      const path = parts.length ? `/${parts.slice(0, 2).join('/')}${parts.length > 2 ? '/...' : ''}` : '';
      return `Fetch ${url.host}${path}`;
    }
    default: return fallback;
  }
}

export function taskAgentLabel(segment: ConversationSegment, actualType?: string): string {
  const requested = isInput(segment.input) ? segment.input.subagent_type : undefined;
  const type = nonEmpty(actualType) ? actualType
    : nonEmpty(requested) ? requested : 'general-purpose';
  const label = type.replace(/-/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}
