/**
 * Statistics for experiment results. Pure and dependency-free so the numbers
 * can be checked against known values (stats.test.ts).
 *
 * - Conversion rates are compared with a two-sided two-proportion z-test
 *   (pooled standard error), the textbook test for "did more people convert".
 * - The difference in rates gets a 95% Wald interval (unpooled standard error).
 * - Relative uplift (variant rate / control rate - 1) gets a 95% interval on
 *   the log of the rate ratio (delta method), so it never goes below -100%.
 * - Sample ratio mismatch: a chi-square goodness-of-fit test of the exposed
 *   counts against the configured weights.
 */

/** Two-sided 95% critical value of the standard normal. */
export const Z95 = 1.959963984540054;

/** erfc with relative error below 1.2e-7 everywhere (Numerical Recipes, Chebyshev fit). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** Standard normal cumulative distribution. */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/** Two-sided p-value of a z statistic. */
export function twoSidedP(z: number): number {
  return Math.min(1, erfc(Math.abs(z) / Math.SQRT2));
}

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized upper incomplete gamma Q(a, x) (series below a + 1, continued fraction above). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const lead = -x + a * Math.log(x) - lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(lead);
  }
  // Lentz's method.
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(lead) * h;
}

/** P(X ≥ x) for a chi-square variable with `df` degrees of freedom. */
export function chiSquareSurvival(x: number, df: number): number {
  return Math.max(0, Math.min(1, gammaQ(df / 2, x / 2)));
}

export interface Proportion {
  /** People exposed. */
  n: number;
  /** People who converted. */
  x: number;
}

export interface Comparison {
  controlRate: number;
  variantRate: number;
  /** variantRate - controlRate, with its 95% interval. */
  diff: number;
  diffLow: number;
  diffHigh: number;
  /** variantRate / controlRate - 1, with its 95% interval; null when the control has no conversions. */
  uplift: number | null;
  upliftLow: number | null;
  upliftHigh: number | null;
  z: number;
  pValue: number;
}

export const rate = (p: Proportion) => (p.n > 0 ? p.x / p.n : 0);

/** Two-proportion z-test of a variant against the control, with 95% intervals. */
export function compareProportions(control: Proportion, variant: Proportion): Comparison {
  const p1 = rate(control);
  const p2 = rate(variant);
  const diff = p2 - p1;
  const pooled = control.n + variant.n > 0 ? (control.x + variant.x) / (control.n + variant.n) : 0;
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(control.n, 1) + 1 / Math.max(variant.n, 1)));
  const z = sePooled > 0 ? diff / sePooled : 0;
  const se = Math.sqrt((p1 * (1 - p1)) / Math.max(control.n, 1) + (p2 * (1 - p2)) / Math.max(variant.n, 1));
  let uplift: number | null = null;
  let upliftLow: number | null = null;
  let upliftHigh: number | null = null;
  if (control.x > 0 && variant.x > 0) {
    const logRatio = Math.log(p2 / p1);
    const seLog = Math.sqrt((1 - p2) / variant.x + (1 - p1) / control.x);
    uplift = p2 / p1 - 1;
    upliftLow = Math.exp(logRatio - Z95 * seLog) - 1;
    upliftHigh = Math.exp(logRatio + Z95 * seLog) - 1;
  } else if (control.x > 0) {
    uplift = p2 / p1 - 1;
  }
  return { controlRate: p1, variantRate: p2, diff, diffLow: diff - Z95 * se, diffHigh: diff + Z95 * se, uplift, upliftLow, upliftHigh, z, pValue: sePooled > 0 ? twoSidedP(z) : 1 };
}

/** Fewest exposed people per variant before results are shown as a test. */
export const MIN_EXPOSED = 100;
/** Fewest conversions (and non-conversions) per variant for the normal approximation to hold. */
export const MIN_CONVERSIONS = 5;

/** True when both groups are large enough for the z-test to mean something. */
export function enoughData(control: Proportion, variant: Proportion): boolean {
  return [control, variant].every((g) => g.n >= MIN_EXPOSED && g.x >= MIN_CONVERSIONS && g.n - g.x >= MIN_CONVERSIONS);
}

/**
 * The significance level per comparison: 5%, split across the comparisons
 * with the control (Bonferroni) when there is more than one treatment, so
 * testing several variants doesn't raise the chance of a false winner.
 */
export function alphaFor(comparisons: number): number {
  return 0.05 / Math.max(1, comparisons);
}

export interface SampleRatio {
  chiSquare: number;
  df: number;
  pValue: number;
  /** Expected exposed people per variant from the weights. */
  expected: number[];
  /** True when the split is very unlikely under the weights (p < 0.001) with enough people to tell. */
  mismatch: boolean;
}

/** Below this many exposed people in all, a lopsided split is still plausible noise. */
export const SRM_MIN_TOTAL = 100;
export const SRM_ALPHA = 0.001;

/** Chi-square goodness of fit of the exposed counts against the weights. */
export function sampleRatioMismatch(observed: number[], weights: number[]): SampleRatio {
  const total = observed.reduce((a, b) => a + b, 0);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const expected = weights.map((w) => (wsum > 0 ? (total * w) / wsum : 0));
  const chiSquare = observed.reduce((acc, o, i) => (expected[i] > 0 ? acc + (o - expected[i]) ** 2 / expected[i] : acc), 0);
  const df = Math.max(1, observed.length - 1);
  const pValue = total > 0 ? chiSquareSurvival(chiSquare, df) : 1;
  return { chiSquare, df, pValue, expected, mismatch: total >= SRM_MIN_TOTAL && pValue < SRM_ALPHA };
}
