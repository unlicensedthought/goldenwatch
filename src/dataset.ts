export interface GoldenCase<I = unknown, E = unknown> {
  id: string;
  input: I;
  expect: E;
  /** Strata this case belongs to (intent, difficulty, failure mode). Agreement is reported per tag. */
  tags?: string[];
}

export interface Dataset<I = unknown, E = unknown> {
  cases: GoldenCase<I, E>[];
  /** SHA-256 of the canonical JSON of every case, in id order. Two runs are comparable only if this matches. */
  hash: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

export async function hashCases(cases: readonly GoldenCase[]): Promise<string> {
  const sorted = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bytes = new TextEncoder().encode(sorted.map(canonical).join('\n'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function validateCase(raw: unknown, where: string): GoldenCase {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`${where}: a case must be a JSON object`);
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id === '') throw new TypeError(`${where}: "id" must be a non-empty string`);
  if (!('input' in c)) throw new TypeError(`${where} (${c.id}): missing "input"`);
  if (!('expect' in c)) throw new TypeError(`${where} (${c.id}): missing "expect"`);
  if (c.tags !== undefined && !(Array.isArray(c.tags) && c.tags.every((t) => typeof t === 'string'))) {
    throw new TypeError(`${where} (${c.id}): "tags" must be an array of strings`);
  }
  return { id: c.id, input: c.input, expect: c.expect, ...(c.tags ? { tags: c.tags as string[] } : {}) };
}

/** Build a dataset from already-parsed cases. Rejects malformed cases and duplicate ids. */
export async function datasetFrom<I = unknown, E = unknown>(raw: readonly unknown[]): Promise<Dataset<I, E>> {
  if (raw.length === 0) throw new TypeError('dataset: no cases');
  const cases = raw.map((r, i) => validateCase(r, `case ${i + 1}`));
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new TypeError(`dataset: duplicate id ${c.id}`);
    seen.add(c.id);
  }
  return { cases: cases as GoldenCase<I, E>[], hash: await hashCases(cases) };
}

/** Parse JSONL: one case per line, blank lines ignored. A bad line names its line number. */
export async function parseJsonl<I = unknown, E = unknown>(text: string): Promise<Dataset<I, E>> {
  const raw: unknown[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    try {
      raw.push(JSON.parse(line));
    } catch (e) {
      throw new SyntaxError(`dataset: line ${i + 1} is not valid JSON: ${String(e).slice(0, 120)}`);
    }
  }
  return datasetFrom<I, E>(raw);
}
