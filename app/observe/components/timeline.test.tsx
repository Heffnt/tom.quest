// The timeline holds six lanes, holds one when the map asks for one, and every
// run bar is a link into the run view.

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import Timeline from "./timeline";
import { LANES } from "../map-data";
import type { RunMark, TimeWindow } from "../lib";

vi.mock("next/link", () => ({
  default: (props: Record<string, unknown>) => <a {...props} />,
}));

const WIN: TimeWindow = { from: 0, to: 1000, kind: "day", offset: 0 };

const RUN: RunMark = {
  runId: "claude:box:abcdefgh",
  parentRunId: null,
  depth: 0,
  host: "box",
  environment: "worker",
  cli: "claude",
  kind: "job",
  status: "ended",
  model: "opus",
  startedAt: 100,
  lastLineAt: 400,
  endedReason: null,
  cwd: null,
  gitBranch: null,
  wikitomCommit: null,
};

afterEach(() => cleanup());

describe("the timeline", () => {
  it("names all six lanes", () => {
    const { container } = render(
      <Timeline win={WIN} now={500} runs={[]} events={[]} rulings={[]} onlyLane={null} />,
    );
    for (const lane of LANES) expect(container.textContent).toContain(lane);
  });

  it("holds one lane when the map asks for one", () => {
    const { container } = render(
      <Timeline win={WIN} now={500} runs={[]} events={[]} rulings={[]} onlyLane="merges" />,
    );
    expect(container.textContent).toContain("merges");
    expect(container.textContent).not.toContain("sessions");
  });

  it("makes a run bar a link into the run view", () => {
    const { container } = render(
      <Timeline win={WIN} now={500} runs={[RUN]} events={[]} rulings={[]} onlyLane={null} />,
    );
    const link = container.querySelector("a[href^='/sessions?run=']");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(`/sessions?run=${encodeURIComponent(RUN.runId)}`);
  });

  it("places a bar across the window it covers", () => {
    const { container } = render(
      <Timeline win={WIN} now={500} runs={[RUN]} events={[]} rulings={[]} onlyLane={null} />,
    );
    const bar = container.querySelector("a[href^='/sessions?run=']") as HTMLElement;
    expect(Number.parseFloat(bar.style.left)).toBeCloseTo(10);
    expect(Number.parseFloat(bar.style.width)).toBeCloseTo(30);
  });
});
