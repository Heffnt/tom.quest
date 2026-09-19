// The runners block on the batches tab: what a row shows, what it expands to,
// where its title goes, and the one action, which is Tom's alone.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { api } from "@/convex/_generated/api";
import { runnerTierWords } from "@/convex/ttsCompose";
import RunnersBlock from "./runners-block";

const convex = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  isTom: true,
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useQuery: (ref: unknown, args: unknown) =>
      args === "skip" ? undefined : convex.data[name(ref as never)],
    useMutation: (ref: unknown) => async (args: unknown) => {
      convex.calls.push({ name: name(ref as never), args });
    },
  };
});

// app/lib/auth pulls in Sentry, which does not load under jsdom.
vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ isTom: convex.isTom, canReadSurface: () => true }),
}));

const NOW = 1_756_000_000_000;
const STEP_RUN = "claude:box:00000000-0000-4000-8000-000000000002";
const EARLIER_RUN = "claude:box:00000000-0000-4000-8000-000000000001";

const LIVE = {
  runnerId: "r1",
  title: "TRAIN25 campaign",
  type: "campaign",
  experimentHost: "turing",
  stepMs: 600_000,
  nextStepAt: NOW + 7 * 60_000,
  createdAt: NOW - 3_600_000,
  endedAt: null,
  status: "waiting-on-tom",
  openBlockingAsks: 1,
  lastCheckIn: { at: NOW - 12 * 60_000, line: "14 of 20 jobs are running." },
  stepRunId: STEP_RUN,
};

const ENDED = {
  ...LIVE,
  runnerId: "r0",
  title: "An ended probe",
  type: "probe",
  endedAt: NOW - 86_400_000,
  status: "done",
  openBlockingAsks: 0,
  lastCheckIn: null,
  stepRunId: null,
};

const DETAIL = {
  document: "# TRAIN25\n\n## Objective\n\nWatch the **sweep**.\n",
  documentVersion: 3,
  checkIns: [
    { id: "c2", at: NOW - 12 * 60_000, stepRunId: STEP_RUN, decision: "ask", verdict: "pass", text: "14 of 20 jobs are running." },
    { id: "c1", at: NOW - 22 * 60_000, stepRunId: EARLIER_RUN, decision: "continue", verdict: "fail", text: "12 of 20 jobs are running." },
  ],
  asks: [
    {
      id: "a1",
      at: NOW - 12 * 60_000,
      stepRunId: STEP_RUN,
      tier: "setup",
      blocking: true,
      answeredAt: null,
      answerText: null,
      text: "Move the sweep to the long partition?",
    },
  ],
};

beforeEach(() => {
  cleanup();
  convex.calls.length = 0;
  convex.isTom = true;
  convex.data = {
    [getFunctionName(api.ttsRunners.listRunners)]: [LIVE, ENDED],
    [getFunctionName(api.ttsRunners.runnerDetail)]: DETAIL,
  };
});

describe("the runners block", () => {
  it("shows a live runner's six facts and the waiting-on-Tom marker in words", () => {
    render(<RunnersBlock now={NOW} />);
    const title = screen.getByRole("link", { name: "TRAIN25 campaign" });
    const row = title.closest(".rounded-lg") as HTMLElement;
    const text = row.textContent ?? "";
    expect(text).toContain("turing");
    expect(text).toContain("campaign");
    expect(text).toContain("every 10m");
    expect(text).toContain("12 min ago · 14 of 20 jobs are running.");
    expect(text).toContain("next step in 7 min");
    expect(within(row).getByText("waiting on Tom")).toBeTruthy();
  });

  it("opens the newest step run in the run view from the title", () => {
    render(<RunnersBlock now={NOW} />);
    expect(screen.getByRole("link", { name: "TRAIN25 campaign" }).getAttribute("href")).toBe(
      `/sessions?run=${encodeURIComponent(STEP_RUN)}`,
    );
  });

  it("expands to the document, every check-in newest first, and the question with its tier in words", () => {
    render(<RunnersBlock now={NOW} />);
    fireEvent.click(screen.getAllByRole("button", { name: "expand" })[0]);
    fireEvent.click(screen.getByRole("button", { name: /document · version 3/ }));
    expect(screen.getByText("Objective")).toBeTruthy();
    expect(screen.getByText("sweep").tagName).toBe("STRONG");

    const checkIns = screen.getAllByRole("link", { name: "step run" });
    expect(checkIns.map((a) => a.getAttribute("href"))).toEqual([
      `/sessions?run=${encodeURIComponent(STEP_RUN)}`,
      `/sessions?run=${encodeURIComponent(EARLIER_RUN)}`,
    ]);
    expect(screen.getByText(/it asked a question/)).toBeTruthy();
    expect(screen.getByText(/it changed nothing · did not pass the writing check/)).toBeTruthy();

    expect(screen.getByText("Move the sweep to the long partition?")).toBeTruthy();
    const facts = screen.getByText(new RegExp(runnerTierWords.setup)).textContent ?? "";
    expect(facts).toContain("its steps change nothing until answered");
    expect(facts).toContain("unanswered");
    expect(facts).not.toContain("setup ");
  });

  it("keeps ended runners under a fold", () => {
    render(<RunnersBlock now={NOW} />);
    expect(screen.queryByText("An ended probe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /ended runners/ }));
    expect(screen.getByText("An ended probe")).toBeTruthy();
    expect(screen.getByText(/ended 1 day ago/)).toBeTruthy();
  });

  it("creates a runner through createRunner, with the step length in milliseconds", async () => {
    render(<RunnersBlock now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "New runner" }));
    const dialog = screen.getByRole("dialog", { name: "New runner" });
    fireEvent.change(within(dialog).getByPlaceholderText("title"), { target: { value: "Seed variance" } });
    fireEvent.change(within(dialog).getByLabelText("type"), { target: { value: "probe" } });
    fireEvent.change(within(dialog).getByLabelText("step length in minutes"), { target: { value: "15" } });
    fireEvent.change(within(dialog).getByPlaceholderText("objective"), { target: { value: "Run five seeds." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create runner" }));
    await vi.waitFor(() => expect(convex.calls).toHaveLength(1));
    expect(convex.calls[0]).toEqual({
      name: getFunctionName(api.ttsRunners.createRunner),
      args: {
        title: "Seed variance",
        type: "probe",
        experimentHost: "turing",
        repo: expect.any(String),
        stepMs: 900_000,
        from: { kind: "prompt", text: "Run five seeds." },
      },
    });
  });

  it("offers no action to anyone but Tom", () => {
    convex.isTom = false;
    render(<RunnersBlock now={NOW} />);
    expect(screen.queryByRole("button", { name: "New runner" })).toBeNull();
    expect(screen.getByRole("link", { name: "TRAIN25 campaign" })).toBeTruthy();
  });

  it("renders nothing while loading, and nothing for a reader with no runners to see", () => {
    convex.data = {};
    const { container } = render(<RunnersBlock now={NOW} />);
    expect(container.textContent).toBe("");
    cleanup();
    convex.isTom = false;
    convex.data = { [getFunctionName(api.ttsRunners.listRunners)]: [] };
    expect(render(<RunnersBlock now={NOW} />).container.textContent).toBe("");
  });
});
