import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LineChart from "./line-chart";

describe("LineChart", () => {
  it("keeps unit-bearing axis ticks, date endpoints, and the latest value visible", () => {
    render(
      <LineChart
        points={[
          { x: "2026-09-01", y: 180 },
          { x: "2026-09-08", y: 181 },
        ]}
        unit="lb"
      />,
    );

    expect(screen.getByText("180 lb")).toBeTruthy();
    expect(screen.getAllByText("181 lb")).toHaveLength(2);
    expect(screen.getByText("Sep 1")).toBeTruthy();
    expect(screen.getByText("Sep 8")).toBeTruthy();
    expect(screen.getByLabelText("Latest value: 181 lb")).toBeTruthy();
  });

  it("lists each run bar's count and miles in visible text", () => {
    render(
      <LineChart
        points={[
          { x: "2026-09-01", y: 1, label: "1 run · 3.1 mi" },
          { x: "2026-09-08", y: 2, label: "2 runs · 6.0 mi" },
        ]}
        unit="runs"
        variant="bar"
      />,
    );

    expect(screen.getByText("Sep 1: 1 run · 3.1 mi")).toBeTruthy();
    expect(screen.getByText("Sep 8: 2 runs · 6.0 mi")).toBeTruthy();
    expect(document.querySelector("title")).toBeNull();
  });
});
