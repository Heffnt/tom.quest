// group-plot toolbar tests — the x/y MetricPickers (the SAME searchable picker
// the main plot mounts on its axes) render the current metric labels and write
// the SHARED store.plot, so the panels re-resolve off the one config.

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import { useBoolbackStore, DEFAULT_TABLE } from "../state/store";
import { DEFAULT_PLOT, DEFAULT_GROUP_EXTRAS } from "../lib/types";
import { indexMetricSchema } from "../lib/metrics";
import { GroupPlotBody } from "./group-plot";

const bundle = asBundle(structuredClone(sample));
const index = indexMetricSchema(bundle.metric_schema);

const mount = () =>
  render(<GroupPlotBody rows={bundle.rows} bundle={bundle} index={index} />);

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
