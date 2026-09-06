// THE CARD'S EMPTY READY LIST — the one line that has to say something true.
//
// A batch with no ready work is the normal state of a batch that is waiting on
// something, and the card exists to say WHICH something. "nothing ready" alone
// (what the card said before the lifeos update, beside a count of blocked
// rows) sends a reader into the graph to find out why. So the line is fixed
// here in both directions: the words "no ready todo", and the unmet need named
// after them — a batch this batch waits on first, because none of its own
// tasks can move until that lands, then the first waiting task's own reason
// (ttsShared.waitingReasonText, the one spelling of a reason anywhere).
//
// None of it is visible to a type checker: a card that names the wrong need,
// or names none, compiles.

import { describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import BatchCard, { noReadyReason, type BatchGraph } from "./batch-card";

const NOW = 1_756_000_000_000;
const DAY = 86_400_000;

const task = (over: Partial<BatchGraph["tasks"][number]>) => ({
  id: "t1",
  statement: "write the amendment",
  actor: "agent" as const,
  status: "active" as const,
  needs: [] as string[],
  readiness: "prepared" as const,
  rulable: false,
  ...over,
});

const graph = (over: Partial<BatchGraph> = {}): BatchGraph => ({
  id: "batch-1",
  statement: "Land the lifeos update",
  tasks: [],
  goals: [],
  ...over,
});

function show(g: BatchGraph) {
  render(
    <BatchCard
      graph={g}
      now={NOW}
      expanded
      onToggle={() => {}}
      onRule={() => {}}
      onDetail={() => {}}
      onGroundUp={() => {}}
      onOpenSession={() => {}}
    />,
  );
}

const body = () => document.body.textContent ?? "";

describe("the batch card's empty ready list", () => {
  it("says the words and names the task's unmet need", () => {
    show(
      graph({
        tasks: [
          task({ id: "a", statement: "pick the shape", status: "done" as const }),
          task({
            id: "b",
            statement: "write it up",
            needs: ["c"],
          }),
          task({ id: "c", statement: "read the audits" , needs: ["b"] }),
        ],
      }),
    );
    // Both b and c are waiting (on each other), so nothing is ready.
    expect(body()).toContain("no ready todo — waiting on: read the audits");
    cleanup();
  });

  it("names the batch this batch waits on, ahead of any task's reason", () => {
    const g = graph({
      needs: [
        { id: "batch-0", statement: "Land the data model", met: false },
        { id: "batch-x", statement: "Preserve the vault", met: true },
      ],
      tasks: [task({ id: "b", statement: "write it up", needs: ["c"] })],
    });
    show(g);
    expect(body()).toContain("no ready todo — waiting on: Land the data model");
    // The met need is not what it waits on.
    expect(noReadyReason(g, NOW)).toBe("waiting on: Land the data model");
    cleanup();
  });

  it("names a sleep by its instant, in the one spelling", () => {
    show(
      graph({
        tasks: [task({ id: "b", statement: "chase the landlord", wakeAt: NOW + DAY })],
      }),
    );
    expect(body()).toContain("no ready todo — waiting until ");
    cleanup();
  });

  it("says the words alone when nothing is in the way", () => {
    show(
      graph({
        tasks: [task({ id: "a", statement: "pick the shape", status: "done" as const })],
      }),
    );
    expect(body()).toContain("no ready todo");
    expect(body()).not.toContain("no ready todo —");
    cleanup();
  });

  // witness: ask ttsShared.isReady — the WORKER's frontier, which does not
  // read readiness — about a todo of Tom's. A raw capture nobody has written
  // up then lists under "ready now", which is the one thing ruling 18 says it
  // never is: the card would be telling him to go and do a todo that is still
  // a sentence someone typed into a capture box.
  it("does not call an unprepared todo of Tom's ready", () => {
    show(
      graph({
        tasks: [
          task({
            id: "a",
            statement: "renew the visa",
            actor: "tom" as const,
            readiness: "unprepared" as const,
          }),
        ],
      }),
    );
    expect(body()).toContain("no ready todo — waiting: unprepared");
    cleanup();
  });

  it("calls an unprepared task of an agent's ready — it is worked from raw", () => {
    show(
      graph({
        tasks: [
          task({
            id: "a",
            statement: "harvest the audits",
            readiness: "unprepared" as const,
          }),
        ],
      }),
    );
    expect(body()).not.toContain("no ready todo");
    expect(screen.getAllByText("harvest the audits").length).toBeGreaterThan(0);
    cleanup();
  });

  it("lists the ready work instead, when there is any", () => {
    show(
      graph({
        tasks: [
          task({ id: "a", statement: "pick the shape", actor: "tom" as const }),
          task({ id: "b", statement: "write it up", needs: ["a"] }),
        ],
      }),
    );
    expect(body()).not.toContain("no ready todo");
    expect(screen.getAllByText("pick the shape").length).toBeGreaterThan(0);
    // …and the one that is not ready says why, on its own row.
    expect(body()).toContain("waiting on: pick the shape");
    cleanup();
  });
});
