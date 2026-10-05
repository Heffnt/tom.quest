// The disagreement list contains decisions the delegate actually took, and a
// run whose items were all skipped passed nothing.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Decision, EvalItem } from "@/convex/jarvis/intent";
import Decisions from "./decisions";

afterEach(() => cleanup());

const DECISION: Decision = {
  id: "e1",
  at: 1_700_000_000_000,
  askId: "86f2f341",
  caller: "job:proof",
  question: "One session or two?",
  options: ["One.", "Two."],
  decision: "One.",
  reason: "His pages say one.",
  restedOn: [],
  wouldChange: null,
  refused: false,
  refusedBecause: null,
  model: null,
  todoId: null,
  decidedByTom: false,
  waitedMs: null,
  settled: null,
};

const ITEM: EvalItem = {
  name: "rule/ruling-758ddm40",
  runId: "run1",
  set: "rule",
  pass: null,
  note: "",
  at: 1,
  model: null,
  passed: 0,
  runs: 1,
  settled: null,
};

function draw(
  decisions: Decision[],
  evalItems: EvalItem[],
  onSettle: () => Promise<unknown> = async () => {},
  focusAskId: string | null = null,
) {
  render(
    <Decisions
      decisions={decisions}
      evalItems={evalItems}
      focusAskId={focusAskId}
      lines={[]}
      selected={null}
      onSelect={() => {}}
      onSettle={onSettle}
    />,
  );
}

describe("Decisions", () => {
  it("lists a decision taken and excludes refused or unanswered rows", () => {
    draw([
      DECISION,
      { ...DECISION, id: "e2", askId: "refused", question: "Refused question", decision: null, refused: true, refusedBecause: "money" },
      { ...DECISION, id: "e3", askId: "unanswered", question: "Unanswered question", decision: null },
    ], []);
    expect(screen.getByText("accept")).toBeTruthy();
    expect(screen.getAllByText("object")).toHaveLength(1);
    expect(screen.queryByText("Refused question")).toBeNull();
    expect(screen.queryByText("Unanswered question")).toBeNull();
  });

  it("marks the row a notification opened, as the fragment's anchor, and scrolls nothing", () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    try {
      draw([DECISION, { ...DECISION, id: "e2", askId: "11111111", question: "Another question" }], [], async () => {}, "86f2f341");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    const row = document.getElementById("decision-86f2f341");
    expect(row?.tagName).toBe("LI");
    expect(row?.getAttribute("aria-current")).toBe("true");
    expect(document.getElementById("decision-11111111")?.getAttribute("aria-current")).toBeNull();
    expect(scrolled).toEqual([]);
  });

  it("does not call a run whose items were all skipped a pass", () => {
    draw([], [ITEM, { ...ITEM, name: "rule/b" }]);
    expect(screen.queryByText(/passed\.$/)).toBeNull();
    expect(screen.getByText("No item of the newest runs was scored: all 2 were skipped.")).toBeTruthy();
    cleanup();
    draw([], [{ ...ITEM, pass: true }, { ...ITEM, name: "rule/b" }]);
    expect(screen.getByText("Every scored item of the newest runs passed; 1 was skipped.")).toBeTruthy();
  });

  // witness: a refused settle was an unhandled rejection with nothing on the
  // page, so he could not tell whether it was recorded.
  it("shows a settle the record refused, under the controls", async () => {
    draw([DECISION], [], async () => {
      throw new Error("decision 86f2f341 was refused or not answered; there is nothing to accept");
    });
    fireEvent.click(screen.getByText("accept"));
    await waitFor(() => expect(screen.getByText(/^not recorded: /)).toBeTruthy());
    // Below the controls, not inside their row.
    const message = screen.getByText(/^not recorded: /);
    const row = screen.getByText("accept").parentElement!;
    expect(row.contains(message)).toBe(false);
    expect(row.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((screen.getByText("accept") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says who decided after how long, and offers no accept or object on his own decision", () => {
    draw([
      { ...DECISION, id: "t1", askId: "7e000001", question: "Tom's question", decidedByTom: true, waitedMs: 720_000 },
      { ...DECISION, id: "d1", askId: "7e000002", question: "Waited question", waitedMs: 7_200_000 },
    ], []);
    expect(screen.getByText("decided by Tom after 12 minutes")).toBeTruthy();
    expect(screen.getByText("decided by the delegate after waiting 120 minutes")).toBeTruthy();
    // One accept and one object: the delegate's decision only.
    expect(screen.getAllByText("accept")).toHaveLength(1);
    expect(screen.getAllByText("object")).toHaveLength(1);
    expect(screen.getByText("Tom's question").closest("li")!.querySelector("button")).toBeNull();
  });

  it("captions object as the revise it records", () => {
    draw([DECISION], []);
    fireEvent.click(screen.getAllByLabelText("what this does")[1]);
    expect(screen.getByText(/verdict: "approve" \| "revise", sentence\? \}\)/)).toBeTruthy();
    expect(screen.getByText(/takes his sentence/)).toBeTruthy();
  });
});

describe("Decisions, times", () => {
  it("prints when a decision was taken in the display form, in America/New_York", () => {
    draw([{ ...DECISION, at: Date.parse("2026-10-05T01:58:00Z") }], []);
    expect(screen.getByText("Sun Oct 4, 9:58 pm")).toBeTruthy();
  });
});
