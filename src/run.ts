import type { Dataset, GoldenCase } from './dataset.ts';

export interface CallResult<O> {
  output: O;
  /** Tokens this case consumed. Counted against the run budget. */
  tokens: number;
  costUsd?: number;
}

export interface Grade {
  agrees: boolean;
  /** Why it did not agree, one short string per reason. Empty when it agrees. */
  failures: string[];
}

export interface CaseReport {
  id: string;
  tags: string[];
  agrees: boolean;
  failures: string[];
  /** The call threw. An outage, not a disagreement: counted separately. */
  callFailed: boolean;
  latencyMs: number;
}

export interface TagSummary {
  cases: number;
  agreement: number;
}

export interface Summary {
  /** Agreeing cases over all graded cases. A failed call counts against it. */
  agreement: number;
  /** Agreeing cases over cases whose call returned. Separates model quality from outages. */
  agreementOfReturned: number;
  failedCalls: number;
  byTag: Record<string, TagSummary>;
}

export interface GoldenRun {
  datasetHash: string;
  runAt: string;
  summary: Summary;
  reports: CaseReport[];
  total: number;
  tokensUsed: number;
  costUsd: number;
  stoppedAtBudget: boolean;
  /** Ids that were never attempted because the budget ran out. Empty on a complete run. */
  ungraded: string[];
}

export interface RunOptions<I, E, O> {
  dataset: Dataset<I, E>;
  call: (c: GoldenCase<I, E>) => Promise<CallResult<O>>;
  grade: (c: GoldenCase<I, E>, output: O) => Grade;
  /** Run budget is cases x this. The run stops, loudly, when it is spent. */
  maxTokensPerCase: number;
  now?: () => number;
  onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

const CALL_FAILED = 'call_failed';

export function summarize(reports: readonly CaseReport[]): Summary {
  const returned = reports.filter((r) => !r.callFailed);
  const rate = (rs: readonly CaseReport[]): number => (rs.length ? rs.filter((r) => r.agrees).length / rs.length : 0);
  const byTag: Record<string, TagSummary> = Object.create(null);
  const groups = new Map<string, CaseReport[]>();
  for (const r of reports) for (const t of r.tags) groups.set(t, [...(groups.get(t) ?? []), r]);
  for (const [tag, rs] of groups) byTag[tag] = { cases: rs.length, agreement: rate(rs) };
  return {
    agreement: rate(reports),
    agreementOfReturned: rate(returned),
    failedCalls: reports.length - returned.length,
    byTag,
  };
}

/**
 * Run every case in order under a token budget. One failed call never stops
 * the run; a spent budget does, and the cases it skipped are named.
 */
export async function runGolden<I, E, O>(opts: RunOptions<I, E, O>): Promise<GoldenRun> {
  const { dataset, maxTokensPerCase } = opts;
  if (!Number.isFinite(maxTokensPerCase) || maxTokensPerCase <= 0) {
    throw new RangeError(`runGolden: maxTokensPerCase must be finite and > 0, got ${maxTokensPerCase}`);
  }
  const now = opts.now ?? Date.now;
  const emit = opts.onEvent ?? (() => {});
  const budget = dataset.cases.length * maxTokensPerCase;
  const reports: CaseReport[] = [];
  let tokensUsed = 0;
  let costUsd = 0;
  let ungraded: string[] = [];

  for (const [i, c] of dataset.cases.entries()) {
    if (tokensUsed >= budget) {
      ungraded = dataset.cases.slice(i).map((u) => u.id);
      emit('golden.budget_exceeded', { tokensUsed, budget, ungraded });
      break;
    }
    const t0 = now();
    const tags = c.tags ?? [];
    try {
      const res = await opts.call(c);
      if (!Number.isFinite(res.tokens) || res.tokens < 0) {
        throw new RangeError(`call returned invalid token count ${res.tokens}`);
      }
      tokensUsed += res.tokens;
      costUsd += res.costUsd ?? 0;
      const g = opts.grade(c, res.output);
      reports.push({ id: c.id, tags, agrees: g.agrees, failures: g.failures, callFailed: false, latencyMs: now() - t0 });
    } catch (e) {
      emit('golden.case_failed', { id: c.id, cause: String(e).slice(0, 300) });
      reports.push({ id: c.id, tags, agrees: false, failures: [CALL_FAILED], callFailed: true, latencyMs: now() - t0 });
    }
  }

  return {
    datasetHash: dataset.hash,
    runAt: new Date(now()).toISOString(),
    summary: summarize(reports),
    reports,
    total: dataset.cases.length,
    tokensUsed,
    costUsd,
    stoppedAtBudget: ungraded.length > 0,
    ungraded,
  };
}
