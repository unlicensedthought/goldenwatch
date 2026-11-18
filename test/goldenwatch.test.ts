import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  casesNeeded,
  datasetFrom,
  detectionPower,
  parseJsonl,
  regressionGate,
  renderReport,
  runGolden,
  runWatched,
  worstCases,
  type Dataset,
  type GoldenCase,
  type GoldenRun,
} from '../src/index.ts';

type Case = GoldenCase<string, string>;

const raw = (n: number, tag = 'a'): Case[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${String(i + 1).padStart(3, '0')}`, input: `in${i}`, expect: 'yes', tags: [tag] }));

const exact = (c: Case, out: string) => (out === c.expect ? { agrees: true, failures: [] } : { agrees: false, failures: [`expected ${c.expect}, got ${out}`] });

async function run(ds: Dataset<string, string>, wrong: Set<string>, opts: { tokens?: number; fail?: Set<string>; max?: number } = {}): Promise<GoldenRun> {
  return runGolden({
    dataset: ds,
    call: async (c) => {
      if (opts.fail?.has(c.id)) throw new Error('upstream 503');
      return { output: wrong.has(c.id) ? 'no' : 'yes', tokens: opts.tokens ?? 10, costUsd: 0.001 };
    },
    grade: exact,
    maxTokensPerCase: opts.max ?? 100,
    now: () => 1_700_000_000_000,
  });
}

test('dataset hash ignores case order and key order, and changes when a case changes', async () => {
  const a = await datasetFrom(raw(5));
  const b = await datasetFrom([...raw(5)].reverse().map((c) => ({ tags: c.tags, expect: c.expect, input: c.input, id: c.id })));
  assert.equal(a.hash, b.hash);
  const edited = raw(5);
  edited[2]!.expect = 'no';
  assert.notEqual((await datasetFrom(edited)).hash, a.hash);
});

test('dataset rejects duplicates, missing fields, empty sets and bad JSONL lines by name', async () => {
  await assert.rejects(datasetFrom([...raw(2), raw(1)[0]]), /duplicate id c001/);
  await assert.rejects(datasetFrom([{ id: 'x', input: 1 }]), /\(x\): missing "expect"/);
  await assert.rejects(datasetFrom([]), /no cases/);
  await assert.rejects(parseJsonl('{"id":"a","input":1,"expect":2}\n{oops'), /line 2 is not valid JSON/);
  const ds = await parseJsonl('{"id":"a","input":1,"expect":2}\n\n{"id":"b","input":1,"expect":2}\n');
  assert.equal(ds.cases.length, 2);
});

test('a failed call is counted as an outage, not a disagreement, and does not stop the run', async () => {
  const ds = await datasetFrom<string, string>(raw(10));
  const r = await run(ds, new Set(['c002']), { fail: new Set(['c005']) });
  assert.equal(r.reports.length, 10);
  assert.equal(r.summary.failedCalls, 1);
  assert.equal(r.summary.agreement, 0.8);
  assert.equal(r.summary.agreementOfReturned, 8 / 9);
  assert.deepEqual(worstCases(r).map((w) => w.id), ['c005', 'c002']);
});

test('the run stops at the token budget and names every case it skipped', async () => {
  const ds = await datasetFrom<string, string>(raw(10));
  const r = await run(ds, new Set(), { tokens: 250, max: 100 });
  assert.equal(r.stoppedAtBudget, true);
  assert.equal(r.reports.length, 4);
  assert.deepEqual(r.ungraded, ['c005', 'c006', 'c007', 'c008', 'c009', 'c010']);
  assert.equal(r.tokensUsed, 1000);
});

test('an invalid token count from the caller is a failed call, never a free one', async () => {
  const ds = await datasetFrom<string, string>(raw(2));
  const r = await runGolden({ dataset: ds, call: async () => ({ output: 'yes', tokens: Number.NaN }), grade: exact, maxTokensPerCase: 10 });
  assert.equal(r.summary.failedCalls, 2);
  await assert.rejects(runGolden({ dataset: ds, call: async () => ({ output: 'yes', tokens: 1 }), grade: exact, maxTokensPerCase: 0 }), /maxTokensPerCase/);
});

test('agreement is reported per tag', async () => {
  const ds = await datasetFrom<string, string>([...raw(4, 'easy'), ...raw(4, 'hard').map((c) => ({ ...c, id: `h${c.id}` }))]);
  const r = await run(ds, new Set(['hc001', 'hc002']));
  assert.deepEqual(r.summary.byTag.easy, { cases: 4, agreement: 1 });
  assert.deepEqual(r.summary.byTag.hard, { cases: 4, agreement: 0.5 });
});

test('gate: passes within tolerance, fails on a real drop and names the tag that fell', async () => {
  const ds = await datasetFrom<string, string>([...raw(50, 'easy'), ...raw(50, 'hard').map((c) => ({ ...c, id: `h${c.id}` }))]);
  const base = await run(ds, new Set(['c001']));
  const small = await run(ds, new Set(['c001', 'c002', 'c003']));
  assert.equal(regressionGate(small, base).verdict, 'pass');
  const bad = await run(ds, new Set(['c001', ...raw(8).map((c) => `h${c.id}`)]));
  const g = regressionGate(bad, base);
  assert.equal(g.verdict, 'regressed');
  assert.ok(Math.abs(g.drop! - 0.08) < 1e-9);
  assert.ok(g.reasons.some((x) => x.startsWith('tag hard:')));
  assert.ok(!g.reasons.some((x) => x.startsWith('tag easy:')));
});

test('gate: a small tag that wobbled within chance is not named as the cause', async () => {
  const ds = await datasetFrom<string, string>([...raw(50, 'steady'), ...raw(50, 'broken').map((c) => ({ ...c, id: `h${c.id}` }))]);
  const base = await run(ds, new Set(raw(5).map((c) => c.id)));
  const bad = await run(ds, new Set([...raw(7).map((c) => c.id), ...raw(20).map((c) => `h${c.id}`)]));
  const g = regressionGate(bad, base);
  assert.equal(g.verdict, 'regressed');
  assert.ok(g.reasons.some((x) => x.startsWith('tag broken:')));
  assert.ok(!g.reasons.some((x) => x.startsWith('tag steady:')), 'a 4-point fall over 50 cases is inside chance');
});

test('gate: refuses a changed dataset, a budget-stopped run and an outage instead of scoring them', async () => {
  const ds = await datasetFrom<string, string>(raw(20));
  const base = await run(ds, new Set());
  const other = await datasetFrom<string, string>(raw(21));
  assert.equal(regressionGate(await run(other, new Set()), base).verdict, 'incomparable');
  assert.equal(regressionGate(await run(ds, new Set(), { tokens: 500 }), base).verdict, 'incomplete');
  const outage = regressionGate(await run(ds, new Set(), { fail: new Set(['c001', 'c002']) }), base);
  assert.equal(outage.verdict, 'incomplete');
  assert.match(outage.reasons[0]!, /2 of 20 calls failed/);
});

test('power: matches a hand-checked value, grows with n, and casesNeeded reaches the target', () => {
  // By hand: z = (0.1*sqrt(100) - 1.645*sqrt(0.09)) / sqrt(0.16) = 1.266, and Phi(1.266) = 0.897.
  assert.ok(Math.abs(detectionPower(100, 0.9, 0.1) - 0.897) < 0.002);
  assert.ok(detectionPower(38, 0.9, 0.05) < detectionPower(380, 0.9, 0.05));
  const n = casesNeeded(0.9, 0.05);
  assert.ok(detectionPower(n, 0.9, 0.05) >= 0.8);
  assert.ok(detectionPower(n - 1, 0.9, 0.05) < 0.8);
  assert.throws(() => detectionPower(10, 0.9, 0.95), /drop must be/);
  assert.throws(() => casesNeeded(1, 0.1), /baseline must be/);
});

test('report states a budget stop, the gate verdict and the worst cases', async () => {
  const ds = await datasetFrom<string, string>(raw(10));
  const base = await run(ds, new Set());
  const r = await run(ds, new Set(['c003']), { fail: new Set(['c001', 'c002', 'c004']) });
  const rep = renderReport('demo', r, [{ runAt: '2026-01-01T00:00:00Z', agreement: 1, cases: 10 }], regressionGate(r, base));
  assert.match(rep.subject, /agreement 60\.0% \(10 cases, 2023-11-14\) \[incomplete\]/);
  assert.match(rep.text, /3 never returned \(outage, not a disagreement\)/);
  assert.match(rep.text, /- c001: the call never returned/);
  assert.match(rep.text, /- c003: expected yes, got no/);
  const stopped = renderReport('demo', await run(ds, new Set(), { tokens: 500 }));
  assert.match(stopped.text, /STOPPED AT THE TOKEN BUDGET - 8 case\(s\)/);
  assert.match(stopped.subject, /2 of 10 cases/);
});

test('watchdog: a crash produces a report, and a failed crash report is still surfaced', async () => {
  const sent: string[] = [];
  const events: string[] = [];
  const ok = await runWatched({ name: 'demo', job: async () => 7, reporter: async (r) => void sent.push(r.subject) });
  assert.deepEqual(ok, { ok: true, value: 7 });
  assert.equal(sent.length, 0);

  const crashed = await runWatched({
    name: 'demo',
    job: async () => {
      throw new Error('dataset missing');
    },
    reporter: async (r) => void sent.push(`${r.subject}|${r.text}`),
    onEvent: (e) => void events.push(e),
  });
  assert.deepEqual(crashed, { ok: false, error: 'Error: dataset missing', crashReported: true });
  assert.match(sent[0]!, /could not run\|.*unmeasured, not as passing.*dataset missing/s);

  const silent = await runWatched({
    name: 'demo',
    job: async () => {
      throw new Error('boom');
    },
    reporter: async () => {
      throw new Error('mail down');
    },
    onEvent: (e) => void events.push(e),
  });
  assert.deepEqual(silent, { ok: false, error: 'Error: boom', crashReported: false });
  assert.deepEqual(events, ['golden.crashed', 'golden.crashed', 'golden.crash_report_failed']);
});
