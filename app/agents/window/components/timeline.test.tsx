// The timeline holds seven lanes, collapses a lane with nothing in it to one
// line, groups the workers lane by the job each run names, and opens a mark in
// place rather than leaving the page.

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
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
  origin: "cron:time-notes",
  startedAt: 100,
  lastLineAt: 400,
  endedReason: null,
  turns: 2,
  toolCalls: 4,
  totalTokens: 900,
  costUsd: 0.25,
  mergeKey: null,
  cwd: null,
  gitBranch: null,
  wikitomCommit: null,
};

const run = (over: Partial<RunMark>): RunMark => ({ ...RUN, ...over });

const draw = (runs: RunMark[], onlyLane: Parameters<typeof Timeline>[0]["onlyLane"] = null) =>
  render(
    <Timeline win={WIN} now={500} runs={runs} events={[]} rulings={[]} onlyLane={onlyLane} />,
  );

afterEach(() => cleanup());

describe("the timeline", () => {
  it("names all seven lanes", () => {
    const { container } = draw([]);
    for (const lane of LANES) expect(container.textContent).toContain(lane);
  });

  it("holds one lane when the map asks for one", () => {
    const { container } = draw([], "merges");
    expect(container.textContent).toContain("merges");
    expect(container.textContent).not.toContain("sessions");
  });

  it("gives a lane with nothing in it one line and no rows", () => {
    const { container } = draw([]);
    expect(container.querySelectorAll("button[aria-expanded]").length).toBe(0);
  });

  it("groups the workers lane by the job each run names", () => {
    const { container } = draw(
      [
        run({ runId: "a", origin: "cron:time-notes" }),
        run({ runId: "b", origin: "cron:time-notes", startedAt: 500, lastLineAt: 600 }),
        run({ runId: "c", origin: "cron:digest" }),
      ],
      "workers",
    );
    expect(container.textContent).toContain("time-notes");
    expect(container.textContent).toContain("digest");
    // Two bars on the grouped row, one on the other, and no row per run.
    expect(container.querySelectorAll("button[aria-expanded]").length).toBe(3);
  });

  it("keeps a spawned worker in its own row rather than a job group", () => {
    const { container } = draw([run({ runId: "d", origin: "daemon", kind: "subagent" })], "workers");
    expect(container.textContent).toContain("spawned");
  });

  it("opens a mark in place, with one link to its agent page on this site", () => {
    const { container } = draw([RUN], "workers");
    const bar = container.querySelector("button[aria-expanded]") as HTMLElement;
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(bar);
    expect(container.textContent).toContain("2 turns");
    const link = container.querySelector("a") as HTMLElement;
    expect(link.getAttribute("href")).toBe(`/agents?view=window&agent=${encodeURIComponent(RUN.runId)}`);
  });

  it("places a bar across the window it covers", () => {
    const { container } = draw([RUN], "workers");
    const bar = container.querySelector("button[aria-expanded]") as HTMLElement;
    expect(Number.parseFloat(bar.style.left)).toBeCloseTo(10);
    expect(Number.parseFloat(bar.style.width)).toBeCloseTo(30);
  });

  it("never sends the reader off this site", () => {
    const { container } = draw([RUN], "workers");
    fireEvent.click(container.querySelector("button[aria-expanded]") as HTMLElement);
    for (const link of container.querySelectorAll("a")) {
      expect(link.getAttribute("href")?.startsWith("/")).toBe(true);
    }
    void within;
  });
});

// The box lane (plan-root T1): every change to the Jarvis Box, and the deploy
// job's own rows, as marks at the time each happened on the box.
describe("the box lane", () => {
  it("draws a box change at its own time and a deploy, and opens a change to its agent", () => {
    const events = [
      {
        id: "e1",
        at: 900,
        kind: "box-change",
        key: "claude:box:s1",
        todoId: null,
        data: { source: "sudo", why: "ran-as-root", command: "/usr/bin/apt-get install -y jq", user: "jarvis", at: 300, agentId: "claude:box:s1" },
      },
      { id: "e2", at: 600, kind: "deploy", key: "Jarvis:888b43a", todoId: null, data: { repo: "Jarvis", from: "1cdb2c2aaaa", to: "888b43a0000" } },
      { id: "e3", at: 700, kind: "tts-opened", key: null, todoId: null, data: null },
    ];
    const { container } = render(<Timeline win={WIN} now={1000} runs={[]} events={events} rulings={[]} onlyLane="box" />);
    const marks = container.querySelectorAll("button[aria-expanded]");
    expect(marks.length).toBe(2);
    fireEvent.click(marks[0]);
    expect(container.textContent).toContain("jarvis ran as root: /usr/bin/apt-get install -y jq");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/agents?view=window&agent=claude%3Abox%3As1");
    fireEvent.click(within(container).getByRole("button", { name: "deployed Jarvis 888b43a" }));
    expect(container.textContent).toContain("from 1cdb2c2");
  });
});
