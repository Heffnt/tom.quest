// THE WAITING ROW, which is the whole reason this dialog exists.
//
// The card outside prints ONE reason — the first thing in the way — because a
// card that listed every unmet need of every task would be a graph drawn in
// words. The dialog is where the whole of it is. So the row has to carry both
// halves whenever a row has both: the computed reason
// (ttsShared.waitingReason, hard blocks first) AND every unmet need by name.
// A sleeping task with two unmet needs reads as a sleep and nothing else if
// the needs are printed only for a "need" reason, and the detail nobody else
// shows is then shown nowhere.

import { describe, it, expect } from "vitest";
import { cleanup, render } from "@testing-library/react";
import DetailDialog, { type DetailItem } from "./detail-dialog";
import type { GraphTask } from "./batch-card";

const NOW = 1_756_000_000_000;
const DAY = 86_400_000;

const TASK: GraphTask = {
  id: "t1",
  statement: "file the renewal",
  actor: "tom",
  status: "active",
  needs: ["t2", "t3"],
  readiness: "prepared",
  rulable: false,
};

function show(over: Partial<Extract<DetailItem, { kind: "task" }>>) {
  render(
    <DetailDialog
      item={{
        kind: "task",
        batchStatement: "Land the lifeos update",
        task: TASK,
        waiting: null,
        waitingOn: [],
        ...over,
      }}
      onClose={() => {}}
      onGroundUp={() => {}}
    />,
  );
}

const body = () => document.body.textContent ?? "";

describe("the waiting row", () => {
  // witness: print the needs only for a "need" reason. This row's reason is a
  // sleep, because a sleep outranks a need — and the two needs it also has
  // vanish from the one surface that shows them.
  it("shows a sleeping task's reason AND the needs it still has", () => {
    show({
      task: { ...TASK, wakeAt: NOW + DAY },
      waiting: { kind: "wake", at: NOW + DAY },
      waitingOn: ["book the appointment", "find the old passport"],
    });
    expect(body()).toContain("waiting until ");
    expect(body()).toContain(
      "waiting on: book the appointment · find the old passport",
    );
    cleanup();
  });

  it("shows an unprepared task's reason AND its needs", () => {
    show({
      task: { ...TASK, readiness: "unprepared" },
      waiting: { kind: "unprepared" },
      waitingOn: ["book the appointment"],
    });
    expect(body()).toContain("waiting: unprepared");
    expect(body()).toContain("waiting on: book the appointment");
    cleanup();
  });

  it("spells a need reason as the whole list, once", () => {
    show({
      waiting: { kind: "need", id: "t2", statement: "book the appointment" },
      waitingOn: ["book the appointment", "find the old passport"],
    });
    expect(body()).toContain(
      "waiting on: book the appointment · find the old passport",
    );
    // Not the reason's one-need spelling on top of the full list.
    expect(body()).not.toContain(
      "waiting on: book the appointmentwaiting on: book the appointment",
    );
    cleanup();
  });
});
