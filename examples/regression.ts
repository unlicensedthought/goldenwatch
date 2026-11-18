// Simulated end to end. The "model" here is a seeded coin with a fixed error
// rate per tag, so every number this prints is synthetic and reproducible. It
// shows what the harness does, not how any real model performs.
import { casesNeeded, datasetFrom, detectionPower, regressionGate, renderReport, runGolden, runWatched, type GoldenCase } from '../src/index.ts';

type Case = GoldenCase<{ text: string }, { intent: string }>;

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = ['action', 'question', 'meta', 'no_op'];
const cases: Case[] = Array.from({ length: 200 }, (_, i) => {
  const tag = TAGS[i % TAGS.length]!;
  return { id: `case-${String(i + 1).padStart(3, '0')}`, input: { text: `utterance ${i + 1}` }, expect: { intent: tag }, tags: [tag] };
});
const dataset = await datasetFrom<Case['input'], Case['expect']>(cases);

function model(errorRate: Record<string, number>, seed: number, tokens = 400) {
  const rnd = seeded(seed);
  return async (c: Case) => {
    const wrong = rnd() < (errorRate[c.expect.intent] ?? 0);
    return { output: { intent: wrong ? 'other' : c.expect.intent }, tokens, costUsd: tokens * 0.000002 };
  };
}
const grade = (c: Case, out: { intent: string }) =>
  out.intent === c.expect.intent ? { agrees: true, failures: [] } : { agrees: false, failures: [`intent: expected ${c.expect.intent}, got ${out.intent}`] };

const now = () => Date.UTC(2026, 10, 16);
const v1 = { action: 0.06, question: 0.06, meta: 0.06, no_op: 0.06 };
const baseline = await runGolden({ dataset, call: model(v1, 1), grade, maxTokensPerCase: 600, now });

console.log('1. Same prompt, a different sampling seed (noise, not a regression)');
const rerun = await runGolden({ dataset, call: model(v1, 2), grade, maxTokensPerCase: 600, now });
const g1 = regressionGate(rerun, baseline);
console.log(`   baseline ${(baseline.summary.agreement * 100).toFixed(1)}%, rerun ${(rerun.summary.agreement * 100).toFixed(1)}% -> ${g1.verdict}`);

console.log('\n2. A prompt change that breaks one intent');
const v2 = { ...v1, meta: 0.4 };
const broken = await runGolden({ dataset, call: model(v2, 2), grade, maxTokensPerCase: 600, now });
const g2 = regressionGate(broken, baseline);
console.log(`   ${g2.verdict}`);
for (const r of g2.reasons) console.log(`   ${r}`);

console.log('\n3. The same change, but the new prompt uses three times the tokens');
const costly = await runGolden({ dataset, call: model(v2, 2, 1800), grade, maxTokensPerCase: 600, now });
const g3 = regressionGate(costly, baseline);
console.log(`   graded ${costly.reports.length} of ${costly.total}, agreement over those ${(costly.summary.agreement * 100).toFixed(1)}% -> ${g3.verdict}`);
for (const r of g3.reasons) console.log(`   ${r}`);

console.log('\n4. The eval job itself crashes');
const outbox: string[] = [];
const w = await runWatched({
  name: 'demo',
  job: async () => {
    throw new Error('price table missing for model x');
  },
  reporter: async (r) => void outbox.push(r.subject),
});
console.log(`   ok=${w.ok}, crash reported=${!w.ok && w.crashReported}, sent: "${outbox[0]}"`);

console.log('\n5. How small a regression can a set see? (baseline 90%, one-sided 5% test)');
for (const n of [38, 100, 200, 500]) {
  console.log(`   ${String(n).padStart(3)} cases: ${(detectionPower(n, 0.9, 0.05) * 100).toFixed(0)}% chance to catch a 5-point drop, ${(detectionPower(n, 0.9, 0.1) * 100).toFixed(0)}% for a 10-point drop`);
}
console.log(`   cases needed for 80% power: ${casesNeeded(0.9, 0.05)} (5-point drop), ${casesNeeded(0.9, 0.1)} (10-point drop)`);

console.log('\n--- report for run 2 ---');
console.log(renderReport('demo', broken, [{ runAt: baseline.runAt, agreement: baseline.summary.agreement, cases: baseline.total }], g2).text);
