// The disagreement list holds the failing eval items and no delegate
// decision (those are settled on the Jarvis thread), and a run whose items
// were all skipped passed nothing.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EvalItem } from "@/convex/jarvis/intent";
import Decisions from "./decisions";

afterEach(() => cleanup());

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

function draw(evalItems: EvalItem[], onSettle: () => Promise<unknown> = async () => {}) {
  render(<Decisions evalItems={evalItems} lines={[]} selected={null} onSelect={() => {}} onSettle={onSettle} />);
}

describe("Decisions", () => {
  it("renders the failing eval items and no delegate decisions section", () => {
    draw([{ ...ITEM, pass: false, note: "the judge said revise" }]);
    expect(screen.getByText("failing eval items")).toBeTruthy();
    expect(screen.getByText("the judge said revise")).toBeTruthy();
    expect(screen.queryByText("delegate decisions")).toBeNull();
  });

  it("does not call a run whose items were all skipped a pass", () => {
    draw([ITEM, { ...ITEM, name: "rule/b" }]);
    expect(screen.queryByText(/passed\.$/)).toBeNull();
    expect(screen.getByText("No item of the newest runs was scored: all 2 were skipped.")).toBeTruthy();
    cleanup();
    draw([{ ...ITEM, pass: true }, { ...ITEM, name: "rule/b" }]);
    expect(screen.getByText("Every scored item of the newest runs passed; 1 was skipped.")).toBeTruthy();
  });

  // witness: a refused settle was an unhandled rejection with nothing on the
  // page, so he could not tell whether it was recorded.
  it("shows a settle the record refused, under the controls", async () => {
    draw([{ ...ITEM, pass: false }], async () => {
      throw new Error("no eval run run1 reporting rule/ruling-758ddm40 in the record");
    });
    fireEvent.click(screen.getByText("stands"));
    await waitFor(() => expect(screen.getByText(/^not recorded: /)).toBeTruthy());
    // Below the controls, not inside their row.
    const message = screen.getByText(/^not recorded: /);
    const row = screen.getByText("stands").parentElement!;
    expect(row.contains(message)).toBe(false);
    expect(row.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((screen.getByText("stands") as HTMLButtonElement).disabled).toBe(false);
  });

  it("captions rule as the revise it records", () => {
    draw([{ ...ITEM, pass: false }]);
    fireEvent.click(screen.getAllByLabelText("what this does")[1]);
    expect(screen.getByText(/verdict: "approve" \| "revise", sentence\? \}\)/)).toBeTruthy();
    expect(screen.getByText(/takes his sentence/)).toBeTruthy();
  });
});
