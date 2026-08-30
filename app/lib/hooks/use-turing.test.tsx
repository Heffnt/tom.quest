// Regression tests for the skip idiom in useTuring. A null path must issue no
// request at all: callers whose path contains an id that is still resolving pass
// null instead of a placeholder segment, which the Turing API answers 404 for.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTuring } from "./use-turing";

vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ token: "test-token" }),
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("useTuring", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("issues no request when the path is null", async () => {
    const { result } = renderHook(() => useTuring<{ status: string }>(null));
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("issues no request when the path is null and a refresh interval is set", async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useTuring<{ status: string }>(null, { refreshInterval: 1 }));
      vi.advanceTimersByTime(5000);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests the proxied path once the path is non-null", async () => {
    renderHook(() => useTuring<{ status: string }>("/forge/serve/run-1"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/turing/forge/serve/run-1");
  });

  it("starts requesting when the path resolves from null to a real path", async () => {
    const { rerender } = renderHook(({ path }: { path: string | null }) => useTuring(path), {
      initialProps: { path: null as string | null },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ path: "/forge/serve/run-2" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/turing/forge/serve/run-2");
  });
});
