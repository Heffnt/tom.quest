// group-plot toolbar tests — the x/y MetricPickers (the SAME searchable picker
// the main plot mounts on its axes) render the current metric labels and write
// the SHARED store.plot, so the panels re-resolve off the one config — plus the
// GRID facet: cell derivation (deriveGridCells) and the two-parameter layout
// (display()-formatted column headers / row labels, raw "<row>|<col>" panel
// keys in the CSV export).

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import { useBoolbackStore, DEFAULT_TABLE } from "../state/store";
import { DEFAULT_PLOT, DEFAULT_GROUP_EXTRAS, type RunRow } from "../lib/types";
import { indexMetricSchema } from "../lib/metrics";
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

  it("exports the raw \"<row>|<col>\" pair as the CSV panel key", () => {
    useBoolbackStore.setState({
      groupPlot: { ...structuredClone(DEFAULT_GROUP_EXTRAS), facet: { kind: "grid", row: "seed", col: "base_model" } },
    });
    const ref: { current: PlotExportHandle | null } = { current: null };
    mount(ref);
    const out = ref.current!.getCsv();
    const [head, ...body] = out.csv.trimEnd().split("\n");
    expect(head.startsWith("layer,panel,")).toBe(true);
    const panels = new Set(body.map((l) => l.split(",")[1]));
    expect(panels.has("0|Llama@c")).toBe(true); // raw values — no shortModel in the data
    expect(panels.has("1|Llama@c")).toBe(true);
  });
});
