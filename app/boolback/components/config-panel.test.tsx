// Settings-editor smoke tests (phase 3) against the real builder fixture:
// the strip (counts, add/duplicate/rename, overlap warning), the ordered
// multi-split editor, and the colorBy gating. Convex is mocked out (the
// header's Views menu is incidental here).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import { useBoolbackStore, DEFAULT_TABLE } from "../state/store";
import { DEFAULT_PLOT, DEFAULT_GROUP_PLOT, EMPTY_FILTER } from "../lib/types";
import { summarizeParameters } from "../lib/parameters";
import { dominantFilters } from "../lib/select";
import ConfigPanel from "./config-panel";
import type { PlotExportHandle } from "./plot-panel";

vi.mock("convex/react", () => ({
  useQuery: () => [],
  useMutation: () => () => Promise.resolve(),
}));
vi.mock("@/convex/_generated/api", () => ({
  api: { boolbackPresets: { list: "l", save: "s", remove: "r" } },
}));

const bundle = asBundle(structuredClone(sample));
const nRuns = bundle.rows.length;
const differing = summarizeParameters(bundle.rows).differing;

const chartRef = { current: null as PlotExportHandle | null };
const mount = () => render(<ConfigPanel bundle={bundle} dir="artifacts" chartRef={chartRef} />);

beforeEach(() => {
  useBoolbackStore.setState({
    centerView: "plot",
    detailOpen: false,
    table: structuredClone(DEFAULT_TABLE),
    plot: structuredClone(DEFAULT_PLOT),
    groupPlot: structuredClone(DEFAULT_GROUP_PLOT),
  });
});

describe("settings strip", () => {
  it("shows the default setting with its matched-run count and the editing caption", () => {
    mount();
    // the active row's name button (title = rename affordance)
    expect(screen.getByTitle("rename this setting").textContent).toBe("all runs");
    // count badge: the unfiltered default matches every run (title from resolveSeries sum)
    expect(screen.getByTitle(`${nRuns} matched runs`).textContent).toBe(String(nRuns));
    expect(screen.getByText("editing:").parentElement!.textContent).toContain("all runs");
    // single setting — delete is disabled
    const del = screen.getByLabelText("remove setting all runs") as HTMLButtonElement;
    expect(del.disabled).toBe(true);
  });

  it("+ add setting appends a DOMINANT-CELL setting (Feature 1) and makes it active", () => {
    mount();
    fireEvent.click(screen.getByText("+ add setting"));
    const { settings } = useBoolbackStore.getState().plot;
    expect(settings).toHaveLength(2);
    // the new setting is active — the chips edit it
    expect(screen.getByText("editing:").parentElement!.textContent).toContain("setting 2");
    // it defaults to the dominant cell (each parameter pinned to its most-common
    // value), NOT an empty/all-runs filter
    expect(settings[1].filters).toEqual(dominantFilters(bundle.rows));
    expect(Object.keys(settings[1].filters.facets).length).toBeGreaterThan(0);
  });

  it("duplicate copies name + filters and becomes active", () => {
    mount();
    fireEvent.click(screen.getByLabelText("duplicate setting all runs"));
    const { settings } = useBoolbackStore.getState().plot;
    expect(settings.map((s) => s.name)).toEqual(["all runs", "all runs copy"]);
    expect(screen.getByText("editing:").parentElement!.textContent).toContain("all runs copy");
  });

  it("clicking the active setting's name opens the inline rename input; Enter commits", () => {
    mount();
    fireEvent.click(screen.getByTitle("rename this setting")); // active row → begins editing
    const input = screen.getByLabelText("setting name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "poisoned only" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useBoolbackStore.getState().plot.settings[0].name).toBe("poisoned only");
  });

  it("the pencil opens the rename editor even on a non-active row; Enter commits", () => {
    mount();
    fireEvent.click(screen.getByText("+ add setting")); // "setting 2" becomes active
    fireEvent.click(screen.getByLabelText("rename setting all runs")); // pencil, inactive row
    const input = screen.getByLabelText("setting name") as HTMLInputElement;
    expect(input.value).toBe("all runs"); // pre-seeded with the current name
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useBoolbackStore.getState().plot.settings[0].name).toBe("renamed");
    expect(screen.queryByLabelText("setting name")).toBeNull(); // editor closed
  });

  it("Escape cancels a rename in progress", () => {
    mount();
    fireEvent.click(screen.getByLabelText("rename setting all runs"));
    const input = screen.getByLabelText("setting name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("setting name")).toBeNull();
    expect(useBoolbackStore.getState().plot.settings[0].name).toBe("all runs");
  });

  it("blur commits; an empty draft commits as the previous name", () => {
    mount();
    fireEvent.click(screen.getByLabelText("rename setting all runs"));
    const input = screen.getByLabelText("setting name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(screen.queryByLabelText("setting name")).toBeNull();
    expect(useBoolbackStore.getState().plot.settings[0].name).toBe("all runs");
  });

  it("the swatch opens a palette popover and a click assigns the color", () => {
    mount();
    fireEvent.click(screen.getByLabelText("change color of setting all runs"));
    fireEvent.click(screen.getByLabelText("use color #f87171"));
    expect(useBoolbackStore.getState().plot.settings[0].color).toBe("#f87171");
  });
});

describe("split by", () => {
  it("adding a split via the dropdown writes splitBy and renders an ordered chip", () => {
    const key = differing[0]?.dim.key;
    expect(key).toBeTruthy(); // fixture must have a differing parameter
    mount();
    fireEvent.change(screen.getByLabelText("add split"), { target: { value: key } });
    expect(useBoolbackStore.getState().plot.splitBy).toEqual([key]);
    expect(screen.getByLabelText(`remove split ${differing[0].dim.label}`)).toBeTruthy();
  });

  it("a constant (inactive) split renders muted with 'one value in view'", () => {
    useBoolbackStore.setState((s) => ({
      plot: { ...s.plot, splitBy: ["not_a_real_param"] },
    }));
    mount();
    expect(screen.getByText("· one value in view")).toBeTruthy();
  });

  it("the arrows reorder splitBy (order is meaningful)", () => {
    const [a, b] = differing.slice(0, 2).map((d) => d.dim.key);
    if (!a || !b) return; // fixture too small to exercise reordering
    useBoolbackStore.setState((s) => ({ plot: { ...s.plot, splitBy: [a, b] } }));
    mount();
    const label = differing[1].dim.label;
    fireEvent.click(screen.getByLabelText(`move split ${label} earlier`));
    expect(useBoolbackStore.getState().plot.splitBy).toEqual([b, a]);
  });
});

describe("color by metric", () => {
  it("offers the gradient select on a single unsplit setting and writes colorBy", () => {
    mount();
    const sel = screen.getByLabelText("Color by metric") as HTMLSelectElement;
    const first = sel.querySelector("option[value]:not([value=''])") as HTMLOptionElement;
    fireEvent.change(sel, { target: { value: first.value } });
    expect(useBoolbackStore.getState().plot.colorBy).toBe(first.value);
  });

  it("is replaced by the muted note once a second setting exists", () => {
    useBoolbackStore.getState().addSetting("plot");
    mount();
    expect(screen.queryByLabelText("Color by metric")).toBeNull();
    expect(screen.getByText("gradient available with a single unsplit setting")).toBeTruthy();
  });

  it("is replaced by the muted note when a split is active", () => {
    const key = differing[0]?.dim.key;
    useBoolbackStore.setState((s) => ({ plot: { ...s.plot, splitBy: [key] } }));
    mount();
    expect(screen.queryByLabelText("Color by metric")).toBeNull();
    expect(screen.getByText("gradient available with a single unsplit setting")).toBeTruthy();
  });
});

describe("reset", () => {
  it("plot views carry NO global Reset — each setting resets individually", () => {
    mount();
    expect(screen.queryByTitle("Reset this view")).toBeNull();
    expect(screen.getByLabelText("reset setting all runs")).toBeTruthy();
  });

  it("⟲ resets ONE setting's filters to the dominant cell, keeping name/color/others", () => {
    // Dirty the first setting's filters and add a second (untouched) setting.
    const filterable = differing.find((d) => d.dim.facetKey)!;
    const fk = filterable.dim.facetKey!;
    const v = filterable.values[0].value;
    useBoolbackStore.getState().setFacet("plot", "s1", fk, [v]);
    const secondId = useBoolbackStore.getState().addSetting("plot");
    mount();
    fireEvent.click(screen.getByLabelText("reset setting all runs"));
    const { settings } = useBoolbackStore.getState().plot;
    const s0 = settings[0];
    expect(s0.name).toBe("all runs");
    expect(s0.filters).toEqual(dominantFilters(bundle.rows));
    // the sibling setting is untouched (store-level addSetting seeds empty)
    expect(settings.find((s) => s.id === secondId)!.filters).toEqual(EMPTY_FILTER);
  });

  it("the table view keeps the single Reset", () => {
    useBoolbackStore.setState({ centerView: "table" });
    mount();
    expect(screen.getByTitle("Reset this view")).toBeTruthy();
  });
});

describe("inline series legend", () => {
  it("an active split renders per-combo series rows under the setting", () => {
    const key = differing[0]?.dim.key;
    expect(key).toBeTruthy();
    useBoolbackStore.setState((s) => ({ plot: { ...s.plot, splitBy: [key] } }));
    const { container } = mount();
    const rows = container.querySelectorAll("[data-legend-series]");
    // one legend row per (setting × combo) — the fixture's differing parameter
    // has >= 2 values, so the single default setting yields >= 2 series rows
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("no split → no series sub-rows (the setting row is the series)", () => {
    const { container } = mount();
    expect(container.querySelectorAll("[data-legend-series]").length).toBe(0);
  });
});
