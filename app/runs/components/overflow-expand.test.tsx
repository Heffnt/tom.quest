// THE EXPAND CONTROL over a cut payload, against a scripted overflow query.
//
// The daemon cuts anything over 32 KB before it writes a transcript row, and
// this control reads the rest back — a page at a time, because one read
// returns at most 1 MB and hands back a cursor. Three things here are
// invisible to a type checker and each is a lie about the transcript:
//   - a paged read that stops after its first page shows a PREFIX as if it
//     were the payload;
//   - a page appended on every re-render (a Convex subscription re-delivers
//     its result freely) DUPLICATES the text;
//   - a walk that stopped at a missing chunk, reported as complete, is the
//     silent truncation this whole path exists to undo.
// So the cases below drive the query the way Convex does — a fresh result for
// each `fromIndex`, re-delivered on re-render — and read the line the control
// prints under the payload.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import OverflowExpand from "./overflow-expand";

/** The scripted pages, by the fromIndex the control asks for. */
const overflow = vi.hoisted(() => ({
  pages: {} as Record<number, unknown>,
  /** Every fromIndex the control asked for, in order. */
  asked: [] as number[],
}));

vi.mock("convex/react", () => ({
  useQuery: (_ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const { fromIndex } = args as { fromIndex: number };
    overflow.asked.push(fromIndex);
    return overflow.pages[fromIndex];
  },
}));

const MESSAGE_ID = "msg-1" as Id<"claudeMessages">;

/** One read's answer, in the shape claudeSessions.getMessageOverflow returns. */
function page(over: Record<string, unknown>) {
  return {
    hasOverflow: true,
    sessionId: "s1",
    seq: 1,
    sha256: "hash",
    chunkCount: 2,
    fromIndex: 0,
    nextIndex: null,
    bytes: 0,
    end: false,
    complete: false,
    text: "",
    ...over,
  };
}

/** The expand itself — never the ⓘ beside it, which explains the read. */
function expandControl(): HTMLElement {
  return screen.getByRole("button", { name: /show the whole payload/ });
}

function open(fullByteLength?: number) {
  render(
    <OverflowExpand messageId={MESSAGE_ID} fullByteLength={fullByteLength} />,
  );
  fireEvent.click(expandControl());
}

const body = () => document.body.textContent ?? "";

beforeEach(() => {
  overflow.pages = {};
  overflow.asked.length = 0;
  cleanup();
});

describe("the expand control", () => {
  it("fetches nothing until it is pressed", () => {
    overflow.pages[0] = page({ text: "the rest", bytes: 8 });
    render(<OverflowExpand messageId={MESSAGE_ID} fullByteLength={8} />);
    expect(overflow.asked).toEqual([]);
    expect(body()).toContain("show the whole payload (8 bytes)");
  });

  it("shows a payload that came back whole, and says the hash was checked", () => {
    overflow.pages[0] = page({
      text: "the whole thing",
      bytes: 15,
      byteLength: 15,
      chunkCount: 1,
      end: true,
      complete: true,
    });
    open(15);
    expect(body()).toContain("the whole thing");
    expect(body()).toContain("complete — 15 bytes, checked against the stored hash");
  });

  it("pages to the end, joins the parts in order, and sums the bytes", () => {
    overflow.pages[0] = page({
      text: "first ",
      bytes: 6,
      byteLength: 12,
      fromIndex: 0,
      nextIndex: 1,
    });
    overflow.pages[1] = page({
      text: "second",
      bytes: 6,
      byteLength: 12,
      fromIndex: 1,
      nextIndex: null,
      end: true,
    });
    open(12);
    expect(overflow.asked).toContain(1);
    expect(screen.getByText("first second")).toBeTruthy();
    expect(body()).toContain("complete — 12 bytes in 2 reads");
    // It does NOT claim the verification it did not do.
    expect(body()).not.toContain("checked against the stored hash");
  });

  it("says incomplete, and why, when the chunks stop short", () => {
    overflow.pages[0] = page({
      text: "first ",
      bytes: 6,
      byteLength: 12,
      fromIndex: 0,
      nextIndex: null, // a hole: the walk stopped without reaching the end
      end: false,
    });
    open(12);
    expect(body()).toContain("first ");
    expect(body()).toContain(
      "incomplete — the stored chunks stop after 6 of 12 bytes; one is missing",
    );
    expect(body()).not.toContain("checked against the stored hash");
  });

  // witness: a payload that came back whole in one read and FAILED the hash
  // comparison. The server checks the hash on exactly this shape, so
  // complete:false here means the stored bytes are not the bytes the row
  // stamped — and the control must not print the paged sentence, which would
  // read as a completeness it never had.
  it("says the one whole read did not match the stored hash", () => {
    overflow.pages[0] = page({
      text: "corrupted bytes",
      bytes: 15,
      byteLength: 15,
      chunkCount: 1,
      fromIndex: 0,
      nextIndex: null,
      end: true,
      complete: false,
    });
    open(15);
    expect(body()).toContain(
      "incomplete — 15 bytes came back but they do not match the stored hash",
    );
    // Not the paged sentence, and not the verified one.
    expect(body()).not.toContain("the hash is checked only when");
    expect(body()).not.toContain("checked against the stored hash");
  });

  it("says incomplete when the bytes do not sum to the row's own stamp", () => {
    overflow.pages[0] = page({
      text: "short",
      bytes: 5,
      byteLength: 12,
      fromIndex: 0,
      nextIndex: null,
      end: true,
    });
    open(12);
    expect(body()).toContain("incomplete — 5 of 12 bytes came back");
  });

  // witness: append each read's text as it arrives instead of keying the
  // pages by the index they were read from — every re-render of the pane (the
  // stream buffer ticks several times a second) doubles the payload.
  it("does not duplicate a page when the subscription re-delivers it", () => {
    overflow.pages[0] = page({
      text: "once",
      bytes: 4,
      byteLength: 4,
      chunkCount: 1,
      end: true,
      complete: true,
    });
    const { rerender } = render(
      <OverflowExpand messageId={MESSAGE_ID} fullByteLength={4} />,
    );
    fireEvent.click(expandControl());
    rerender(<OverflowExpand messageId={MESSAGE_ID} fullByteLength={4} />);
    rerender(<OverflowExpand messageId={MESSAGE_ID} fullByteLength={4} />);
    expect(screen.getByText("once")).toBeTruthy();
  });

  it("says so when the message row itself is gone", () => {
    overflow.pages[0] = null;
    open(12);
    expect(body()).toContain("the message row this payload belongs to is gone");
  });
});
