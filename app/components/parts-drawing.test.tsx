// The SVG renderer of a parts drawing: one element per primitive layoutGraph
// returns and nothing else, a crossing logged as a console error, and a part
// node that is a control (onSelect).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { LEGEND, layoutGraph } from "@/shared/parts-drawing.mjs";
import PartsDrawing, { type Drawing } from "./parts-drawing";

afterEach(() => cleanup());

const node = (id: string, x: number, type = "program") => ({ id, label: [id], x, y: 16, w: 100, h: 40, type });
const DRAWING: Drawing = {
  id: "starts",
  title: "Who starts whom",
  caption: "",
  nodes: [node("a", 16), node("b", 216, "store"), node("c", 416, "wall")],
  edges: [{ from: "a", to: "b", label: "starts", type: "start" }, { from: "b", to: "c", label: "", type: "deny" }],
};

describe("PartsDrawing", () => {
  it("draws one SVG element per primitive of layoutGraph", () => {
    const { container } = render(<PartsDrawing diagram={LEGEND as Drawing} />);
    const layout = layoutGraph(LEGEND.nodes, LEGEND.edges);
    const primitives = layout.shapes.flatMap((s: { primitives: { tag: string }[] }) => s.primitives);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${layout.width} ${layout.height}`);
    // Each arrow is a line, a head and, for deny, a bar; each region a rect.
    const bars = layout.arrows.filter((a: { bar?: unknown }) => a.bar !== undefined).length;
    expect(svg.querySelectorAll("polygon").length).toBe(layout.arrows.length + primitives.filter((p: { tag: string }) => p.tag === "polygon").length);
    expect(svg.querySelectorAll("line").length).toBe(layout.arrows.length + bars + primitives.filter((p: { tag: string }) => p.tag === "line").length);
    expect(svg.querySelectorAll("rect").length).toBe(layout.regions.length + primitives.filter((p: { tag: string }) => p.tag === "rect").length);
    expect(svg.querySelectorAll("ellipse").length).toBe(primitives.filter((p: { tag: string }) => p.tag === "ellipse").length);
    // The legend is not a drawing of parts: none of its boxes is a control.
    expect(svg.querySelectorAll("[role=button]").length).toBe(0);
  });

  it("logs a crossing as a console error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const crossed: Drawing = { ...DRAWING, edges: [{ from: "a", to: "c", label: "", type: "send" }] };
    render(<PartsDrawing diagram={crossed} />);
    expect(error).toHaveBeenCalledWith("arrow crossing: starts: the arrow a to c passes through b");
    error.mockRestore();
  });

  it("makes each part a control with onSelect", () => {
    const onSelect = vi.fn();
    const { container } = render(<PartsDrawing diagram={DRAWING} onSelect={onSelect} />);
    fireEvent.click(container.querySelector("#part-b")!);
    fireEvent.keyDown(container.querySelector("#part-c")!, { key: "Enter" });
    expect(onSelect.mock.calls).toEqual([["b"], ["c"]]);
  });
});
