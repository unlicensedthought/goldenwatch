import type { GoldenRun, TagSummary } from './run.ts';

export type GateVerdict = 'pass' | 'regressed' | 'incomparable' | 'incomplete';

export interface GateResult {
  verdict: GateVerdict;
  /** baseline agreement minus current agreement. Positive means worse. Absent when not compared. */
  drop?: number;
  reasons: string[];
}

export interface GateOptions {
  /** Largest agreement drop, as a fraction, that still passes. Default 0.03. */
  maxDrop?: number;
  /** Largest share of calls that may fail before the run is treated as an outage. Default 0.05. */
  maxFailedCallShare?: number;
}

export type Baseline = Pick<GoldenRun, 'datasetHash' | 'summary'>;

const Z_95_ONE_SIDED = 1.6448536269514722;

/**
 * A tag is small, so its agreement wobbles between identical runs. Name it
 * only when the fall is both over the tolerance and larger than two samples
 * of that size would differ by chance (pooled two-proportion test, one-sided 5%).
 */
function tagFell(base: TagSummary, cur: TagSummary, maxDrop: number): boolean {
  const drop = base.agreement - cur.agreement;
  if (drop <= maxDrop) return false;
  const pooled = (base.agreement * base.cases + cur.agreement * cur.cases) / (base.cases + cur.cases);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / base.cases + 1 / cur.cases));
  return drop > Z_95_ONE_SIDED * se;
}

/**
 * Gate on the baseline, not on an absolute score. Only `pass` should let a
 * release through: a run on a different dataset, a run cut short by its
 * budget, and a run dominated by outages are each refused by name instead of
 * being scored as if they were complete.
 */
export function regressionGate(current: GoldenRun, baseline: Baseline, opts: GateOptions = {}): GateResult {
  const maxDrop = opts.maxDrop ?? 0.03;
  const maxFailed = opts.maxFailedCallShare ?? 0.05;
  if (current.datasetHash !== baseline.datasetHash) {
    return {
      verdict: 'incomparable',
      reasons: [`dataset changed (${baseline.datasetHash.slice(0, 12)} -> ${current.datasetHash.slice(0, 12)}); re-baseline before comparing`],
    };
  }
  const incomplete: string[] = [];
  if (current.stoppedAtBudget) {
    incomplete.push(`stopped at the token budget with ${current.ungraded.length} of ${current.total} cases ungraded`);
  }
  const failedShare = current.reports.length ? current.summary.failedCalls / current.reports.length : 1;
  if (failedShare > maxFailed) {
    incomplete.push(`${current.summary.failedCalls} of ${current.reports.length} calls failed (limit ${(maxFailed * 100).toFixed(0)}%)`);
  }
  if (incomplete.length > 0) return { verdict: 'incomplete', reasons: incomplete };

  const drop = baseline.summary.agreement - current.summary.agreement;
  if (drop > maxDrop) {
    const reasons = [
      `agreement fell ${(drop * 100).toFixed(1)} points (${(baseline.summary.agreement * 100).toFixed(1)}% -> ${(current.summary.agreement * 100).toFixed(1)}%), limit ${(maxDrop * 100).toFixed(1)}`,
    ];
    for (const [tag, cur] of Object.entries(current.summary.byTag)) {
      const base = baseline.summary.byTag[tag];
      if (base && tagFell(base, cur, maxDrop)) {
        reasons.push(`tag ${tag}: ${(base.agreement * 100).toFixed(1)}% -> ${(cur.agreement * 100).toFixed(1)}% over ${cur.cases} cases`);
      }
    }
    return { verdict: 'regressed', drop, reasons };
  }
  return { verdict: 'pass', drop, reasons: [] };
}
