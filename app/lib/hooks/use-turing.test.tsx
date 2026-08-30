// Regression tests for the skip idiom in useTuring. A null path must issue no
// request at all: callers whose path contains an id that is still resolving pass
// null instead of a placeholder segment, which the Turing API answers 404 for.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTuring } from "./use-turing";

// Mutable so a test can hold auth in its resolving state and then settle it.
const authState = vi.hoisted(() => ({
  token: "test-token" as string | null,
  loading: false,
}));

vi.mock("@/app/lib/auth", () => ({
  useAuth: () => authState,
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
    authState.token = "test-token";
    authState.loading = false;
    fetchMock = vi.fn(async () => jsonResponse({ status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Observed live on 2026-08-30: a hard load of /turing sent gpu-types,
  // gpu-report and jobs with NO Authorization header, took three 401s, then
  // sent all three again with the token. The page recovered, so the only
  // visible trace was a flash of "Authentication required" — but a session
  // checking that page could not tell the flash from a real failure.
  it("issues no request until auth has settled, then exactly one", async () => {
    authState.loading = true;
    const { result, rerender } = renderHook(() => useTuring<{ status: string }>("/gpu-report"));
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    // Waiting on auth is not idle: a request is coming, so the caller must see
    // `loading` rather than an empty state.
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    authState.loading = false;
    rerender();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer test-token" },
    });
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
