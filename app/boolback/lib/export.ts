// app/boolback/lib/export.ts — serializers + download helpers for the Export
// menu: CSV (table rows / chart points / summary), booktabs LaTeX for the
// paper's headline tables, and SVG/PNG snapshots of the chart.
//
// The serializers (csv*, latex*, summaryTo*) are pure and unit-tested; the
// download/clipboard/rasterize helpers touch the DOM and are browser-only.

import type { SummaryRow } from "./stats";

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function csvEscape(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of cells -> RFC-4180-ish CSV (with a trailing newline). */
export function toCsv(rows: Array<Array<string | number | boolean | null | undefined>>): string {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// LaTeX (booktabs) — the §5 headline-findings table
// ---------------------------------------------------------------------------

/** Escape LaTeX special characters in a plain-text cell. */
export function latexEscape(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

function fmtNum(v: number | null, decimals: number): string {
  if (v === null || !Number.isFinite(v)) return "--";
  return v.toFixed(decimals);
}

export interface SummaryTableSpec {
  /** Human label of the grouping facet ("model", "arity", …). */
  groupLabel: string;
  /** metric name -> column header label. */
  metricLabels: Record<string, string>;
  /** Ordered metric names (columns). */
  metrics: string[];
  /** Provenance lines embedded as % comments (snapshot built_at, filters…). */
  provenance: string[];
  decimals?: number;
}

/**
 * A booktabs LaTeX table over summary rows: one row per group value (+ All),
 * one "mean ± sd" column per metric, plus an n column. Ready to paste; the
 * provenance comment ties the numbers back to the exact view that made them.
 */
export function summaryToLatex(rows: SummaryRow[], spec: SummaryTableSpec): string {
  const d = spec.decimals ?? 3;
  const cols = spec.metrics;
  const header = [
    latexEscape(spec.groupLabel),
    "$n$",
    ...cols.map((m) => latexEscape(spec.metricLabels[m] ?? m)),
  ].join(" & ");

  const body = rows
    .map((r) => {
      const cells = cols.map((m) => {
        const c = r.cells[m];
        if (!c || c.n === 0) return "--";
        const sd = c.sd === null ? "" : ` $\\pm$ ${fmtNum(c.sd, d)}`;
        return `${fmtNum(c.mean, d)}${sd}`;
      });
      const label = r.group === "All" ? "\\midrule\n\\textbf{All}" : latexEscape(r.group);
      return [label, String(r.n), ...cells].join(" & ") + " \\\\";
    })
    .join("\n");

  const provenance = spec.provenance.map((l) => `% ${l}`).join("\n");
  const colSpec = `l r ${cols.map(() => "c").join(" ")}`;

  return `${provenance}
\\begin{table}[t]
\\centering
\\caption{TODO}
\\label{tab:TODO}
\\begin{tabular}{${colSpec}}
\\toprule
${header} \\\\
\\midrule
${body}
\\bottomrule
\\end{tabular}
\\end{table}
`;
}

/** The same summary as CSV (mean, sd, n columns per metric). */
export function summaryToCsv(rows: SummaryRow[], spec: SummaryTableSpec): string {
  const head: Array<string> = [spec.groupLabel, "n"];
  for (const m of spec.metrics) {
    const label = spec.metricLabels[m] ?? m;
    head.push(`${label} mean`, `${label} sd`, `${label} n`);
  }
  const out: Array<Array<string | number | null>> = [head];
  for (const r of rows) {
    const line: Array<string | number | null> = [r.group, r.n];
    for (const m of spec.metrics) {
      const c = r.cells[m];
      line.push(c?.mean ?? null, c?.sd ?? null, c?.n ?? 0);
    }
    out.push(line);
  }
  return toCsv(out);
}

// ---------------------------------------------------------------------------
// Browser-only: downloads, clipboard, SVG/PNG capture
// ---------------------------------------------------------------------------

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadText(text: string, filename: string, mime = "text/plain"): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * Serialize an on-page SVG element to a standalone SVG string. The chart paints
 * with CSS custom properties (`var(--color-…)`) which do not resolve outside
 * the document, so every fill/stroke/color is resolved to its computed literal
 * value on a deep clone first.
 */
export function svgToString(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src: Element[] = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const dst: Element[] = [clone, ...Array.from(clone.querySelectorAll("*"))];
  for (let i = 0; i < src.length; i++) {
    const cs = window.getComputedStyle(src[i]);
    const el = dst[i] as SVGElement;
    for (const prop of ["fill", "stroke", "color"] as const) {
      const v = cs.getPropertyValue(prop);
      if (v) el.style.setProperty(prop, v);
    }
    // font-family/size matter for <text>
    if (src[i].tagName.toLowerCase() === "text") {
      el.style.setProperty("font-family", cs.getPropertyValue("font-family"));
      el.style.setProperty("font-size", cs.getPropertyValue("font-size"));
    }
  }
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  // An opaque background so the figure reads on any page.
  const bg = window.getComputedStyle(document.body).backgroundColor;
  if (bg) clone.style.setProperty("background-color", bg);
  return new XMLSerializer().serializeToString(clone);
}

/** Rasterize an on-page SVG to a PNG blob at `scale`× its viewBox size. */
export async function svgToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const xml = svgToString(svg);
  const vb = svg.viewBox.baseVal;
  const w = (vb && vb.width ? vb.width : svg.clientWidth) * scale;
  const h = (vb && vb.height ? vb.height : svg.clientHeight) * scale;

  const img = new Image();
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("SVG rasterization failed"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas context");
    const bg = window.getComputedStyle(document.body).backgroundColor;
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
