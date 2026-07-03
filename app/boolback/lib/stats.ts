// app/boolback/lib/stats.ts — pure descriptive statistics for the chart and
// the summary exports.
//
// BOUNDARY RULE (boolback-usability-plan.md §5): everything here is a
// display-tier DESCRIPTIVE aggregation of values the CMT snapshot already
// shipped — mean/sd/n, an OLS trend line, Pearson r / Spearman ρ. Anything
// inferential (confidence intervals, regression modeling, significance) must
// come from CMT (`analysis.estimates`) via the facade, never be added here.

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1). null for n < 2. */
export function stdDev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** Pearson correlation of paired samples. null when undefined (n<2 or zero variance). */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = mean(xs.slice(0, n))!;
  const my = mean(ys.slice(0, n))!;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Fractional ranks with ties averaged (the standard Spearman prerequisite). */
function ranks(xs: number[]): number[] {
  const order = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length);
  let k = 0;
  while (k < order.length) {
    let j = k;
    while (j + 1 < order.length && order[j + 1].v === order[k].v) j++;
    const r = (k + j) / 2 + 1; // average rank, 1-based
    for (let t = k; t <= j; t++) out[order[t].i] = r;
    k = j + 1;
  }
  return out;
}

/** Spearman rank correlation (Pearson over average ranks). */
export function spearman(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  return pearson(ranks(xs.slice(0, n)), ranks(ys.slice(0, n)));
}

export interface OlsFit {
  slope: number;
  intercept: number;
  n: number;
}

/** Ordinary least squares y = a + bx. null when undefined (n<2 or zero x-variance). */
export function olsFit(xs: number[], ys: number[]): OlsFit | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = mean(xs.slice(0, n))!;
  const my = mean(ys.slice(0, n))!;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, n };
}

/**
 * "Nice" axis tick values covering [lo, hi] with roughly `count` steps: the
 * step is 1/2/5 × 10^k, ticks land on multiples of it.
 */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  const span = hi - lo;
  if (span === 0) return [lo];
  const rawStep = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  // Classic nice-number step: 1 / 2 / 5 / 10 × 10^k.
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const first = Math.ceil(lo / step) * step;
  const out: number[] = [];
  // Guard float drift with a half-step epsilon.
  for (let v = first; v <= hi + step / 2; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Group summary (the summary footer + the .tex/CSV headline-table export)
// ---------------------------------------------------------------------------

export interface SummaryCell {
  mean: number | null;
  sd: number | null;
  n: number; // non-null values that entered the mean
}

export interface SummaryRow {
  /** Facet value ("Llama-3.2-1B", "arity 3", …) or "All". */
  group: string;
  /** Rows in the group (regardless of per-metric nulls). */
  n: number;
  /** metric name -> aggregate. */
  cells: Record<string, SummaryCell>;
}

/**
 * Group `items` by `groupOf` and aggregate each metric via `valueOf`. The
 * "All" row (over every item) is appended last. Groups are sorted by value.
 */
export function summarize<T>(
  items: T[],
  metrics: string[],
  groupOf: (item: T) => string | null,
  valueOf: (item: T, metric: string) => number | null,
): SummaryRow[] {
  const byGroup = new Map<string, T[]>();
  for (const it of items) {
    const g = groupOf(it) ?? "—";
    const arr = byGroup.get(g) ?? [];
    arr.push(it);
    byGroup.set(g, arr);
  }
  const groups = [...byGroup.keys()].sort();

  const rowFor = (group: string, groupItems: T[]): SummaryRow => {
    const cells: Record<string, SummaryCell> = {};
    for (const m of metrics) {
      const vals: number[] = [];
      for (const it of groupItems) {
        const v = valueOf(it, m);
        if (v !== null && Number.isFinite(v)) vals.push(v);
      }
      cells[m] = { mean: mean(vals), sd: stdDev(vals), n: vals.length };
    }
    return { group, n: groupItems.length, cells };
  };

  const out = groups.map((g) => rowFor(g, byGroup.get(g)!));
  out.push(rowFor("All", items));
  return out;
}
