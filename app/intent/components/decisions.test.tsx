// The disagreement list offers only what a settlement can mean: a refused or
// unanswered decision has nothing to accept, and a run whose items were all
// skipped passed nothing.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
  settled: null,
};

const ITEM: EvalItem = {
  name: "rule/ruling-758ddm40",
  set: "rule",
  pass: null,
  note: "",
  at: 1,
  model: null,
  passed: 0,
  runs: 1,
  settled: null,
};

function draw(decisions: Decision[], evalItems: EvalItem[]) {
  render(
    <Decisions
      decisions={decisions}
      evalItems={evalItems}
      lines={[]}
      selected={null}
      onSelect={() => {}}
      onSettle={async () => {}}
    />,
  );
}

describe("Decisions", () => {
  it("offers accept on a decision taken, and only object on one refused or unanswered", () => {
    draw([DECISION], []);
    expect(screen.getByText("accept")).toBeTruthy();
    cleanup();
    draw([{ ...DECISION, decision: null, refused: true, refusedBecause: "money" }, { ...DECISION, id: "e2", askId: "x", decision: null }], []);
    expect(screen.queryByText("accept")).toBeNull();
    expect(screen.getAllByText("object")).toHaveLength(2);
  });

  it("does not call a run whose items were all skipped a pass", () => {
    draw([], [ITEM, { ...ITEM, name: "rule/b" }]);
    expect(screen.queryByText(/passed\.$/)).toBeNull();
    expect(screen.getByText("No item of the newest runs was scored: all 2 were skipped.")).toBeTruthy();
    cleanup();
    draw([], [{ ...ITEM, pass: true }, { ...ITEM, name: "rule/b" }]);
    expect(screen.getByText("Every scored item of the newest runs passed; 1 was skipped.")).toBeTruthy();
  });
});
