# goldenwatch

A golden-set regression harness for LLM features. It runs a fixed set of cases
against your model, compares the result with a stored baseline, and tells you
whether the feature got worse. It is built around the ways such a check goes
quietly wrong.

Zero runtime dependencies. TypeScript, runs on Node 22.18+ and on edge runtimes
(it uses only Web Crypto and `TextEncoder`).

## What it refuses to do

Most eval scripts fail open. This one names each case and refuses it:

| Situation | Typical script | goldenwatch |
|---|---|---|
| The run hit its token budget part way | Scores the cases it reached | `incomplete`, lists every ungraded id |
| The provider was down for some cases | Counts them as wrong answers | Counts them as outages; `incomplete` over 5% |
| Someone edited the golden set | Compares anyway | `incomparable` until you re-baseline (dataset hash) |
| The eval job crashed before reporting | Silence, which reads as "nothing to report" | Sends a "could not run" notice |
| A small tag wobbled by chance | Blamed as the cause | Named only if the fall is beyond chance |
| The set is too small to see the drop you care about | Green | `detectionPower` tells you the odds |

## Use

```ts
import { datasetFrom, runGolden, regressionGate, renderReport, runWatched } from 'goldenwatch';

const dataset = await datasetFrom(cases); // [{ id, input, expect, tags? }]

const result = await runWatched({
  name: 'intent-classifier',
  reporter: sendEmail, // (report: { subject, text }) => Promise<void>
  job: async () => {
    const run = await runGolden({
      dataset,
      call: async (c) => {
        const res = await callModel(c.input);
        return { output: res.json, tokens: res.usage.total, costUsd: res.cost };
      },
      grade: (c, out) =>
        out.intent === c.expect.intent
          ? { agrees: true, failures: [] }
          : { agrees: false, failures: [`intent: expected ${c.expect.intent}, got ${out.intent}`] },
      maxTokensPerCase: 600,
    });
    const gate = regressionGate(run, storedBaseline);
    await sendEmail(renderReport('intent-classifier', run, trend, gate));
    return gate;
  },
});

if (!result.ok || result.value.verdict !== 'pass') process.exit(1);
```

Store a baseline by saving `{ datasetHash, summary }` from a run you accept.

## How big does the set need to be?

```ts
import { detectionPower, casesNeeded } from 'goldenwatch';

detectionPower(38, 0.9, 0.05); // 0.30
casesNeeded(0.9, 0.05);        // 253
```

From `npm run demo`, for a feature that agrees with its golden set 90% of the
time (one-sided test at 5%):

| Cases | Chance to catch a 5-point drop | Chance to catch a 10-point drop |
|---|---|---|
| 38 | 30% | 62% |
| 100 | 51% | 90% |
| 200 | 73% | 99% |
| 500 | 96% | 100% |

A 38-case set that comes back green has a 70% chance of missing a 5-point
regression. That is arithmetic, not a measurement of any model.

## Demo

`npm run demo` runs a **simulated** classifier (a seeded coin with a fixed error
rate per tag) through five situations. Every number is synthetic and
reproducible; none describes a real model.

```
1. Same prompt, a different sampling seed (noise, not a regression)
   baseline 94.0%, rerun 92.0% -> pass

2. A prompt change that breaks one intent
   regressed
   agreement fell 10.5 points (94.0% -> 83.5%), limit 3.0
   tag meta: 96.0% -> 62.0% over 50 cases

3. The same change, but the new prompt uses three times the tokens
   graded 67 of 200, agreement over those 83.6% -> incomplete
   stopped at the token budget with 133 of 200 cases ungraded

4. The eval job itself crashes
   ok=false, crash reported=true, sent: "demo golden: the report could not run"
```

## Limits

- The gate compares against a fixed tolerance (`maxDrop`, default 3 points). It
  does not test the overall drop for significance; use `detectionPower` to pick
  a set size and tolerance that mean something together.
- Power figures use the normal approximation for one proportion against a known
  baseline. They are rough below about 30 cases or above about 97% agreement.
- Grading is yours to supply. There is no built-in LLM judge.
- Cases run one at a time, in order.
- No storage: you keep baselines and trend rows wherever you like.

## Develop

```
npm install
npm test          # 12 tests
npm run typecheck
npm run build
```

Apache-2.0.
