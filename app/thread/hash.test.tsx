// A link to /thread#<row id> opens that row.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { CHANGES, MESSAGES, NOW } from "@/test/fixtures/thread";
import { buildDays, type ThreadMessage } from "./feed";
import ThreadView from "./thread-view";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function draw() {
  return render(
    <ThreadView days={buildDays([], [], MESSAGES, CHANGES, NOW)} open={undefined} loading={false} cuts={[]}
      onSend={async () => {}} onAccept={async () => {}} now={NOW} />,
  );
}

const OLD_SETTLED = {
  kind: "decision", id: "old1", at: NOW - 61 * 86_400_000, askId: "0ld00001", question: "Keep the old run?",
  decision: "Keep it.", reason: "It still answers.", restedOn: [], wouldChange: null, caller: "job:plan", model: null,
  todoId: null, decidedByTom: false, waitedMs: null, settled: { at: NOW - 60 * 86_400_000, verdict: "approve", sentence: null },
} as unknown as ThreadMessage & { kind: "decision" };

describe("the fragment", () => {
  it("draws a linked decision older than the stream expanded above it, with its settlement", () => {
    window.location.hash = "#old1";
    const { container } = render(
      <ThreadView days={buildDays([], [], MESSAGES, CHANGES, NOW)} open={undefined} loading={false} cuts={[]}
        linked={OLD_SETTLED} onSend={async () => {}} onAccept={async () => {}} now={NOW} />,
    );
    const row = container.querySelector('[id="old1"]')!;
    expect(row.querySelector("[aria-expanded=true]")!.textContent).toContain("Decision: Keep the old run? Keep it.");
    expect(row.textContent).toContain("It still answers.");
    expect(row.textContent).toContain("stands ·");
    // Above the stream: before the first day's heading.
    const firstDay = container.querySelector("section")!;
    expect(row.compareDocumentPosition(firstDay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });


  it("opens and scrolls to the row a cold link names once the rows arrive, once", () => {
    window.location.hash = "#dec1";
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    try {
      const view = (days: ReturnType<typeof buildDays>) => (
        <ThreadView days={days} open={undefined} loading={days.length === 0} cuts={[]} onSend={async () => {}} onAccept={async () => {}} now={NOW} />
      );
      const { container, rerender } = render(view([]));
      expect(scrolled).toEqual([]);
      rerender(view(buildDays([], [], MESSAGES, CHANGES, NOW)));
      expect(container.querySelector('[id="dec1"] [role=button]')!.getAttribute("aria-expanded")).toBe("true");
      expect(scrolled).toEqual(["dec1"]);
      rerender(view(buildDays([], [], MESSAGES, CHANGES, NOW)));
      expect(scrolled).toEqual(["dec1"]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("reopens a row folded by hand when a later visit names it", () => {
    const { container } = draw();
    const line = () => container.querySelector('[id="dec1"] [role=button]')!;
    fireEvent.click(line());
    expect(line().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(line());
    expect(line().getAttribute("aria-expanded")).toBe("false");
    act(() => {
      window.location.hash = "#dec1";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(line().getAttribute("aria-expanded")).toBe("true");
  });

});
