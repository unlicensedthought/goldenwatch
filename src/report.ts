import type { GateResult } from './gate.ts';
import type { CaseReport, GoldenRun } from './run.ts';

export interface TrendRow {
  runAt: string;
  agreement: number;
  cases: number;
}

export interface Report {
  subject: string;
  text: string;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** Failed calls first, then disagreements, in dataset order. */
export function worstCases(run: GoldenRun, limit = 5): CaseReport[] {
  return run.reports
    .map((r, i) => ({ r, i, w: r.callFailed ? 2 : r.agrees ? 0 : 1 }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.r);
}

export function renderReport(name: string, run: GoldenRun, trend: readonly TrendRow[] = [], gate?: GateResult): Report {
  const s = run.summary;
  const graded = run.reports.length;
  const ofTotal = graded < run.total ? `${graded} of ${run.total}` : `${graded}`;
  const verdict = gate ? ` [${gate.verdict}]` : '';
  const lines: string[] = [
    `${name} golden report - ${run.runAt}`,
    '',
    `Agreement: ${pct(s.agreement)}  (over cases that returned: ${pct(s.agreementOfReturned)})`,
    `Cases graded: ${ofTotal}${s.failedCalls > 0 ? `, of which ${s.failedCalls} never returned (outage, not a disagreement)` : ''}`,
    `Spend: ${run.tokensUsed} tokens, $${run.costUsd.toFixed(4)}`,
    `Dataset: ${run.datasetHash.slice(0, 12)}`,
  ];
  if (run.stoppedAtBudget) {
    lines.push(`STOPPED AT THE TOKEN BUDGET - ${run.ungraded.length} case(s) were not graded: ${run.ungraded.join(', ')}`);
  }
  if (gate) {
    lines.push('', `Gate: ${gate.verdict}`);
    for (const r of gate.reasons) lines.push(`  ${r}`);
  }
  const tags = Object.entries(s.byTag).sort(([a], [b]) => (a < b ? -1 : 1));
  if (tags.length > 0) {
    lines.push('', 'By tag:');
    for (const [tag, t] of tags) lines.push(`  ${tag}: ${pct(t.agreement)} (${t.cases} cases)`);
  }
  lines.push('', 'Trend (newest first):');
  if (trend.length === 0) lines.push('  (first report - no history yet)');
  for (const t of trend) lines.push(`  ${t.runAt.slice(0, 10)}  agreement ${pct(t.agreement)}  (${t.cases} cases)`);
  const worst = worstCases(run);
  lines.push('', worst.length === 0 ? 'Worst cases: none - every case agreed.' : `Worst ${worst.length} case(s):`);
  for (const r of worst) {
    lines.push(`- ${r.id}: ${r.callFailed ? 'the call never returned' : r.failures.join(', ') || 'disagreed'}`);
  }
  return {
    subject: `${name} golden: agreement ${pct(s.agreement)} (${ofTotal} cases, ${run.runAt.slice(0, 10)})${verdict}`,
    text: lines.join('\n'),
  };
}
