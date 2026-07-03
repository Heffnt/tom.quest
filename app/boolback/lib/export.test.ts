// Serializer tests for the Export menu (CSV + booktabs LaTeX). The DOM-touching
// helpers (downloads, SVG/PNG capture) are browser-only and not covered here.

import { describe, it, expect } from "vitest";
import { csvEscape, toCsv, latexEscape, summaryToLatex, summaryToCsv } from "./export";
import { summarize } from "./stats";

describe("csv", () => {
  it("escapes commas, quotes, newlines; passes plain values through", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvEscape("two\nlines")).toBe('"two\nlines"');
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(0.5)).toBe("0.5");
  });

  it("toCsv joins rows with a trailing newline", () => {
    expect(toCsv([["a", "b"], [1, null]])).toBe("a,b\n1,\n");
  });
});

describe("latex", () => {
  it("escapes the specials that appear in model names", () => {
    expect(latexEscape("Llama_3.2-1B_Instruct")).toBe("Llama\\_3.2-1B\\_Instruct");
    expect(latexEscape("50% & more #1 {x}")).toBe("50\\% \\& more \\#1 \\{x\\}");
  });

  const rows = summarize(
    [
      { g: "m_1", v: 0.9 },
      { g: "m_1", v: 0.7 },
      { g: "m2", v: 0.5 },
    ],
    ["plantedness"],
    (it) => it.g,
    (it) => it.v,
  );
  const spec = {
    groupLabel: "Model",
    metricLabels: { plantedness: "Plantedness" },
    metrics: ["plantedness"],
    provenance: ["snapshot built 2026-07-03T00:00:00Z; 3 of 10 runs", "filters: none"],
  };

  it("summaryToLatex: booktabs shape, escaped labels, mean ± sd, provenance comments", () => {
    const tex = summaryToLatex(rows, spec);
    expect(tex).toContain("% snapshot built 2026-07-03T00:00:00Z; 3 of 10 runs");
    expect(tex).toContain("\\toprule");
    expect(tex).toContain("\\midrule");
    expect(tex).toContain("\\bottomrule");
    expect(tex).toContain("m\\_1 & 2 & 0.800 $\\pm$ 0.141 \\\\");
    expect(tex).toContain("\\textbf{All} & 3 & 0.700 $\\pm$ 0.200 \\\\");
    // single-run group: no ± term
    expect(tex).toContain("m2 & 1 & 0.500 \\\\");
  });

  it("summaryToCsv: mean/sd/n columns per metric", () => {
    const csv = summaryToCsv(rows, spec);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("Model,n,Plantedness mean,Plantedness sd,Plantedness n");
    const m1 = lines.find((l) => l.startsWith("m_1,"))!.split(",");
    expect(m1[0]).toBe("m_1");
    expect(m1[1]).toBe("2");
    expect(Number(m1[2])).toBeCloseTo(0.8, 12); // raw float precision preserved in CSV
    expect(lines[lines.length - 1].startsWith("All,3,")).toBe(true);
  });
});
