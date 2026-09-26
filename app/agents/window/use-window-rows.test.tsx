// The window's point events come from two walks (the record's events and
// dtsEvents) and draw under ONE cap: the merged set is cut at 4,000 and
// says it was capped, and neither walk loads more once the two together
// reach it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { api } from "@/convex/_generated/api";

const loadMore = vi.fn();
const rows = (n: number, offset: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `e${offset + i}`, at: offset + i, kind: "merge", key: null, todoId: null, agentId: null, data: null }));
let walks: Record<string, { results: unknown[]; status: string }> = {};

vi.mock("convex/react", () => ({
  usePaginatedQuery: (fn: unknown) => ({ ...walks[getFunctionName(fn as never)], loadMore }),
  useQuery: () => [],
}));

import { useWindowRows } from "./use-window-rows";

afterEach(() => {
  cleanup();
  loadMore.mockClear();
});

describe("useWindowRows", () => {
  // witness: each walk had its own 4,000 cap, so the merged window could
  // draw 8,000 rows and never say it was capped.
  it("draws at most 4,000 merged point events, says it was capped, and loads no more", () => {
    walks = {
      [getFunctionName(api.observe.runsInWindow)]: { results: [], status: "Exhausted" },
      [getFunctionName(api.observe.recordInWindow)]: { results: rows(2500, 0), status: "CanLoadMore" },
      [getFunctionName(api.observe.eventsInWindow)]: { results: rows(2500, 10_000), status: "CanLoadMore" },
    };
    const { result } = renderHook(() => useWindowRows({ from: 0, to: 1 } as never, true));
    expect(result.current.events).toHaveLength(4000);
    expect(result.current.events[0].at).toBe(0);
    expect(result.current.capped).toBe(true);
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("is not capped when the two walks are exhausted under the cap", () => {
    walks = {
      [getFunctionName(api.observe.runsInWindow)]: { results: [], status: "Exhausted" },
      [getFunctionName(api.observe.recordInWindow)]: { results: rows(10, 0), status: "Exhausted" },
      [getFunctionName(api.observe.eventsInWindow)]: { results: rows(10, 100), status: "Exhausted" },
    };
    const { result } = renderHook(() => useWindowRows({ from: 0, to: 1 } as never, true));
    expect(result.current.events).toHaveLength(20);
    expect(result.current.capped).toBe(false);
  });
});
