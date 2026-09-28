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
});
