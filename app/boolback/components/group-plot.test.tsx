// group-plot toolbar tests — the x/y MetricPickers (the SAME searchable picker
// the main plot mounts on its axes) render the current metric labels and write
// the SHARED store.plot, so the panels re-resolve off the one config — plus the
// GRID facet: cell derivation (deriveGridCells) and the two-parameter layout
// (display()-formatted column headers / row labels, raw "<row>|<col>" panel
// keys in the CSV export) — plus the SHARED VIEW WINDOW: the panels' scale
// clamps to plot.xDomain/yDomain (the zoom the main plot's AxisRange editors
// write) and the toolbar mounts the same editors, and the panel viewBox tracks
// panelMin so tick text stays readable at the minimum panel size.

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import { useBoolbackStore, DEFAULT_TABLE } from "../state/store";
import { DEFAULT_PLOT, DEFAULT_GROUP_EXTRAS, type RunRow } from "../lib/types";
import { indexMetricSchema } from "../lib/metrics";
import { resolveAxis } from "../lib/axes";
import { PARAMETERS, type ParameterDef } from "../lib/parameters";
import type { PlotExportHandle } from "./plot-panel";
import { GroupPlotBody, deriveGridCells } from "./group-plot";

const bundle = asBundle(structuredClone(sample));
const index = indexMetricSchema(bundle.metric_schema);

const mount = (exportRef?: { current: PlotExportHandle | null }) =>
  render(<GroupPlotBody rows={bundle.rows} bundle={bundle} index={index} exportRef={exportRef} />);

beforeEach(() => {
  useBoolbackStore.setState({
    centerView: "groupplot",
    detailOpen: false,
    table: structuredClone(DEFAULT_TABLE),
    plot: structuredClone(DEFAULT_PLOT),
    // A facet must be chosen for the toolbar (and panels) to render.
    groupPlot: { ...structuredClone(DEFAULT_GROUP_EXTRAS), facet: { kind: "layer" } },
  });
});

describe("group plot toolbar axis pickers", () => {
  it("renders x and y pickers showing the current metrics, before the facet summary", () => {
    mount();
    // DEFAULT_PLOT: x = "epoch" (pinned sentinel), y = "plantedness".
    expect(screen.getByLabelText("x metric").textContent).toContain("epoch (training progress)");
    const yLabel = index[DEFAULT_PLOT.y]?.label ?? DEFAULT_PLOT.y;
    expect(screen.getByLabelText("y metric").textContent).toContain(yLabel);
    expect(screen.getByText("facet:")).toBeTruthy();
    expect(screen.getByText(/panels/)).toBeTruthy();
  });

  it("picking a y metric writes store.plot.y and the picker follows", () => {
    // Any non-default snapshot metric outside FUNCTION (present in Y_GROUP_ORDER).
    const target = bundle.metric_schema.find(
      (e) => e.group !== "FUNCTION" && e.name !== DEFAULT_PLOT.y && e.min !== null && e.max !== null,
    )!;
    mount();
    fireEvent.click(screen.getByLabelText("y metric"));
    fireEvent.change(screen.getByPlaceholderText("search metrics…"), {
      target: { value: target.name },
    });
    const opt = screen
      .getAllByText(target.label)
      .map((el) => el.closest("button"))
      .find((b): b is HTMLButtonElement => !!b)!;
    fireEvent.click(opt);
    expect(useBoolbackStore.getState().plot.y).toBe(target.name);
    // panels re-resolve off the shared config — the trigger label follows
    expect(screen.getByLabelText("y metric").textContent).toContain(target.label);
  });

  it("picking an x metric writes store.plot.x (leaving epoch mode)", () => {
    const target = bundle.metric_schema.find(
      (e) => e.group === "FUNCTION" && e.min !== null && e.max !== null,
    )!;
    mount();
    fireEvent.click(screen.getByLabelText("x metric"));
    fireEvent.change(screen.getByPlaceholderText("search metrics…"), {
      target: { value: target.name },
    });
    const opt = screen
      .getAllByText(target.label)
      .map((el) => el.closest("button"))
      .find((b): b is HTMLButtonElement => !!b)!;
    fireEvent.click(opt);
    expect(useBoolbackStore.getState().plot.x).toBe(target.name);
    expect(screen.getByLabelText("x metric").textContent).toContain(target.label);
  });
});

// ---------------------------------------------------------------------------
// shared view window — the panels' scale honors plot.xDomain/yDomain and the
// toolbar mounts the main plot's AxisRange min/max editors (axis-range.tsx)
// ---------------------------------------------------------------------------

/** A numeric (FUNCTION complexity) x metric + a numeric y for scatter mode. */
const xMetric = bundle.metric_schema.find(
  (e) => e.group === "FUNCTION" && e.min !== null && e.max !== null,
)!;
const yMetric =
  bundle.metric_schema.find((e) => e.name === "plantedness") ??
  bundle.metric_schema.find((e) => e.group === "OUTCOME" && e.min !== null && e.max !== null)!;

const numericPlot = (over: Partial<typeof DEFAULT_PLOT> = {}) =>
  useBoolbackStore.setState({
    plot: { ...structuredClone(DEFAULT_PLOT), x: xMetric.name, y: yMetric.name, ...over },
  });

/** The x tick labels of the first panel surface (texts on the x baseline,
 *  y = PH - PAD.b + 10), parsed numeric. */
const xTickValues = (container: HTMLElement): number[] => {
  const svg = container.querySelector("svg[viewBox]")!;
  const [, , , H] = svg.getAttribute("viewBox")!.split(" ").map(Number);
  return [...svg.querySelectorAll("text")]
    .filter((t) => Number(t.getAttribute("y")) === H - 20 + 10)
    .map((t) => Number(t.textContent))
    .filter((v) => Number.isFinite(v));
};

describe("group plot shared view window", () => {
  it("the shared scale clamps to a set x window exactly like the main plot", () => {
    // Window strictly inside the metric's data range.
    const ax = resolveAxis(xMetric.name, index, bundle.rows);
    let lo = Infinity, hi = -Infinity;
    for (const r of bundle.rows) {
      const v = ax.value(r);
      if (v === null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo;
    const win: [number, number] = [lo + 0.45 * span, lo + 0.55 * span];

    numericPlot();
    const free = mount();
    const freeTicks = xTickValues(free.container);
    free.unmount();

    numericPlot({ xDomain: win });
    const { container } = mount();
    const ticks = xTickValues(container);
    expect(ticks.length).toBeGreaterThan(0);
    // niceTicks (shared with the main plot) emits a tick up to half a step past
    // the domain max, so bound each tick by the window ± half the tick step —
    // still far tighter than the ~10×-wider free extent below.
    const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : span;
    const tol = step / 2 + 1e-9;
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(win[0] - tol);
      expect(t).toBeLessThanOrEqual(win[1] + tol);
    }
    // …and the window actually changed the scale (the free extent is wider)
    expect(ticks).not.toEqual(freeTicks);
  });

  it("epoch (line) mode honors the shared x window too — parity with the main plot", () => {
    // DEFAULT_PLOT.x is the epoch sentinel; window the epoch axis.
    useBoolbackStore.setState({
      plot: { ...structuredClone(DEFAULT_PLOT), xDomain: [1, 2] },
    });
    const { container } = mount();
    const ticks = xTickValues(container);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(t).toBeLessThanOrEqual(2 + 1e-9);
    }
    // the toolbar editor shows the WINDOW (not the data extent) + a reset
    expect(screen.getByTitle("edit x min (zoom only)").textContent).toBe("1");
    expect(screen.getByTitle("edit x max (zoom only)").textContent).toBe("2");
    expect(screen.getByLabelText("reset x zoom")).toBeTruthy();
  });

  it("the toolbar min/max editors write the shared plot.xDomain / yDomain", () => {
    numericPlot();
    mount();
    // x max first (commit keeps min < max against the current lo)
    fireEvent.click(screen.getByTitle("edit x max (zoom only)"));
    let input = screen.getByLabelText("x max") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useBoolbackStore.getState().plot.xDomain?.[1]).toBe(99);

    fireEvent.click(screen.getByTitle("edit y min (zoom only)"));
    input = screen.getByLabelText("y min") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "-1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useBoolbackStore.getState().plot.yDomain?.[0]).toBe(-1);

    // ⟲ clears the window again (both views read the same nulled domain)
    fireEvent.click(screen.getByLabelText("reset x zoom"));
    expect(useBoolbackStore.getState().plot.xDomain).toBeNull();
  });

  it("the panel viewBox tracks panelMin (1 unit ≈ 1 px at the minimum size)", () => {
    numericPlot();
    useBoolbackStore.setState({
      groupPlot: { facet: { kind: "layer" }, panelMin: 160 },
    });
    const { container } = mount();
    const svg = container.querySelector("svg[viewBox]")!;
    expect(svg.getAttribute("viewBox")).toBe(`0 0 160 ${Math.round(160 * (176 / 260))}`);
  });
});

// ---------------------------------------------------------------------------
// grid facet — deriveGridCells (pure) + the CSS-grid layout
// ---------------------------------------------------------------------------

const def = (key: string): ParameterDef => PARAMETERS.find((d) => d.key === key)!;

// The sample snapshot's seed × base_model occupancy: Llama@c carries seeds
// 0 AND 1, gpt2s@d / qwen72@e only seed 0 → 4 non-empty of the 2×3 cells.
describe("deriveGridCells", () => {
  const series = [{ key: "l1", rows: bundle.rows }];

  it("derives only the NON-EMPTY (row, col) cells, keyed by the raw \"<row>|<col>\" pair", () => {
    const g = deriveGridCells(series, def("seed"), def("base_model"));
    expect(g.rowVals).toEqual(["0", "1"]);
    expect(g.colVals).toEqual(["Llama@c", "gpt2s@d", "qwen72@e"]);
    expect([...g.cells.keys()].sort()).toEqual([
      "0|Llama@c", "0|gpt2s@d", "0|qwen72@e", "1|Llama@c",
    ]); // the two empty seed-1 cells are absent
    // panel value === id === the raw pair (the CSV panel key — no display formatting)
    for (const c of g.cells.values()) expect(c.value).toBe(c.id);
  });

  it("counts DISTINCT runs per cell; pts keep the per-series duplication", () => {
    const twice = [{ key: "l1", rows: bundle.rows }, { key: "l2", rows: bundle.rows }];
    const g = deriveGridCells(twice, def("seed"), def("base_model"));
    const cell = g.cells.get("1|Llama@c")!;
    expect(cell.count).toBe(1); // one distinct run…
    expect(cell.pts).toHaveLength(2); // …scheduled once per matching layer-series
    expect(cell.pts.map((p) => p.key).sort()).toEqual(["l1", "l2"]);
  });

  it("sorts rows/cols by the parameter's rule: numericSort ascending, else lexical", () => {
    // Same rows, synthetic values that ONLY sort correctly under numericSort.
    const val = (r: RunRow) =>
      r.training.base_model === "Llama@c" ? "9" : r.training.base_model === "gpt2s@d" ? "2" : "10";
    const numeric: ParameterDef = { key: "n", label: "N", raw: val, numericSort: true, section: "training" };
    const lexical: ParameterDef = { key: "s", label: "S", raw: val, section: "training" };
    expect(deriveGridCells(series, numeric, def("seed")).rowVals).toEqual(["2", "9", "10"]);
    expect(deriveGridCells(series, lexical, def("seed")).rowVals).toEqual(["10", "2", "9"]);
  });

  it("drops rows where either parameter is null (they belong to no cell)", () => {
    const nullOnLlama: ParameterDef = {
      key: "p", label: "P", section: "training",
      raw: (r) => (r.training.base_model === "Llama@c" ? null : "x"),
    };
    const g = deriveGridCells(series, nullOnLlama, def("base_model"));
    expect(g.colVals).toEqual(["gpt2s@d", "qwen72@e"]); // Llama rows fell out entirely
    expect(g.rowVals).toEqual(["x"]);
  });
});

describe("grid facet layout + export", () => {
  it("renders display()-formatted column headers (shortModel) and row labels, panels = non-empty cells", () => {
    useBoolbackStore.setState({
      groupPlot: { ...structuredClone(DEFAULT_GROUP_EXTRAS), facet: { kind: "grid", row: "seed", col: "base_model" } },
    });
    mount();
    // toolbar: the crossed facet label + the non-empty cell count
    expect(screen.getByText("Seed × Model")).toBeTruthy();
    expect(screen.getByText(/4 panels/)).toBeTruthy();
    // column headers show shortModel("Llama@c") = "Llama" etc., never the raw value
    for (const short of ["Llama", "gpt2s", "qwen72"]) expect(screen.getByText(short)).toBeTruthy();
    expect(screen.queryByText("Llama@c")).toBeNull();
  });

  it("row labels get the parameter's display() too (base_model as the ROW axis)", () => {
    useBoolbackStore.setState({
      groupPlot: { ...structuredClone(DEFAULT_GROUP_EXTRAS), facet: { kind: "grid", row: "base_model", col: "seed" } },
    });
    mount();
    expect(screen.getAllByTitle("Model: Llama").length).toBe(1); // the row label
    expect(screen.queryByText("Llama@c")).toBeNull();
  });

  it("facet-by-function panels are titled with the simplified DNF, not the raw arity:hex", () => {
    useBoolbackStore.setState({
      groupPlot: { ...structuredClone(DEFAULT_GROUP_EXTRAS), facet: { kind: "param", key: "function" } },
    });
    const fnDef = def("function");
    mount();
    // every function that owns runs labels its panel with its dnf_string…
    for (const r of bundle.rows) {
      expect(screen.getAllByText(r.function.dnf_string).length).toBeGreaterThan(0);
      // …and the compact raw value (the bucketing key) never renders as a label
      expect(screen.queryByText(fnDef.raw(r)!)).toBeNull();
    }
  });

  it("grid margins get the function→DNF display too (function as the ROW axis)", () => {
    useBoolbackStore.setState({
      groupPlot: { ...structuredClone(DEFAULT_GROUP_EXTRAS), facet: { kind: "grid", row: "function", col: "seed" } },
    });
    const fnDef = def("function");
    mount();
    for (const r of bundle.rows) {
      expect(screen.getAllByText(r.function.dnf_string).length).toBeGreaterThan(0);
      expect(screen.queryByText(fnDef.raw(r)!)).toBeNull();
    }
  });

  it("a GROUP is ONE panel under facet=layer (its members are not separate panels)", () => {
    useBoolbackStore.setState({
      plot: {
        ...structuredClone(DEFAULT_PLOT),
        layers: [{
          id: "g1", name: "the group", color: "#38bdf8", style: { shape: 0, dash: 0 },
          filters: { facets: {}, ranges: [] },
          members: [
            { id: "m1", name: "llama-only", color: "#f87171", style: { shape: 0, dash: 0 }, filters: { facets: { base_model: ["Llama@c"] }, ranges: [] } },
            { id: "m2", name: "gpt-only", color: "#4ade80", style: { shape: 0, dash: 0 }, filters: { facets: { base_model: ["gpt2s@d"] }, ranges: [] } },
          ],
        }],
      },
      groupPlot: { ...structuredClone(DEFAULT_GROUP_EXTRAS), facet: { kind: "layer" } },
    });
    mount();
    expect(screen.getByText(/1 panels/)).toBeTruthy();
    // the single panel is titled by the GROUP name — never the member names
    expect(screen.getAllByText("the group").length).toBeGreaterThan(0);
    expect(screen.queryByText("llama-only")).toBeNull();
    expect(screen.queryByText("gpt-only")).toBeNull();
  });

  it("exports the raw \"<row>|<col>\" pair as the CSV panel key", () => {
    useBoolbackStore.setState({
      groupPlot: { ...structuredClone(DEFAULT_GROUP_EXTRAS), facet: { kind: "grid", row: "seed", col: "base_model" } },
    });
    const ref: { current: PlotExportHandle | null } = { current: null };
    mount(ref);
    const out = ref.current!.getCsv();
    const [head, ...body] = out.csv.trimEnd().split("\n");
    expect(head.startsWith("layer,member,panel,")).toBe(true);
    const panels = new Set(body.map((l) => l.split(",")[2]));
    expect(panels.has("0|Llama@c")).toBe(true); // raw values — no shortModel in the data
    expect(panels.has("1|Llama@c")).toBe(true);
  });
});
