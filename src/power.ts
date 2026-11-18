function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** Acklam's rational approximation to the standard normal quantile. */
function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

function check(baseline: number, drop: number, alpha: number): void {
  if (!(baseline > 0 && baseline < 1)) throw new RangeError(`baseline must be in (0, 1), got ${baseline}`);
  if (!(drop > 0 && drop < baseline)) throw new RangeError(`drop must be in (0, baseline), got ${drop}`);
  if (!(alpha > 0 && alpha < 0.5)) throw new RangeError(`alpha must be in (0, 0.5), got ${alpha}`);
}

/**
 * Probability that a set of `n` cases detects a true fall from `baseline` to
 * `baseline - drop`, in a one-sided test of one proportion against a known
 * baseline (normal approximation). If this is low, a clean run tells you
 * little: the set is too small to see the regression you care about.
 */
export function detectionPower(n: number, baseline: number, drop: number, alpha = 0.05): number {
  check(baseline, drop, alpha);
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be an integer >= 1, got ${n}`);
  const p1 = baseline - drop;
  const z = (drop * Math.sqrt(n) - normalQuantile(1 - alpha) * Math.sqrt(baseline * (1 - baseline))) / Math.sqrt(p1 * (1 - p1));
  return normalCdf(z);
}

/** Smallest set size that detects the given drop with at least the given power. */
export function casesNeeded(baseline: number, drop: number, power = 0.8, alpha = 0.05): number {
  check(baseline, drop, alpha);
  if (!(power > 0 && power < 1)) throw new RangeError(`power must be in (0, 1), got ${power}`);
  const p1 = baseline - drop;
  const root = normalQuantile(1 - alpha) * Math.sqrt(baseline * (1 - baseline)) + normalQuantile(power) * Math.sqrt(p1 * (1 - p1));
  return Math.ceil((root / drop) ** 2);
}
