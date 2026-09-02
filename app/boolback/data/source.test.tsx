// Regression tests for the rebuild note in useArtifactSource — the one line the
// /boolback Refresh button puts on screen after it submits an sbatch build.
//
// The bug these guard: submit_build in turing-api answered a failed sbatch with
// HTTP 200 and {"status": "error", "detail": …}, while this hook branched on
// res.ok alone. Every failure therefore rendered "rebuild submitted — takes
// ~2 min" and an operator waited two minutes for a snapshot that no job was
// building. The worst case is the FileNotFoundError branch — sbatch missing from
// PATH — because that is what a real cluster outage or a broken login-node
// environment looks like, and it is exactly the case the success message hid.
//
// The hook is tested rather than the page because the note is composed here; the
// page (boolback-client.tsx, filter-bar.tsx) only prints source.rebuildNote.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useArtifactSource } from "./source";

const authState = vi.hoisted(() => ({
  isAdmin: true,
  isTom: true,
  token: "test-token" as string | null,
}));

vi.mock("@/app/lib/auth", () => ({
  useAuth: () => authState,
}));

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Mount the hook with the snapshot GET stubbed 404 (no snapshot for this dir —
 *  the shortest load path, and irrelevant to the rebuild note) and the rebuild
 *  POST answered by `postReply`. Returns after the initial load has settled. */
async function mountWithPost(postReply: () => Promise<Response>) {
  const posts: RequestInit[] = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(init);
      return postReply();
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useArtifactSource());
  await waitFor(() => expect(result.current.status).toBe("empty"));
  return { result, posts, fetchMock };
}

describe("useArtifactSource rebuild note", () => {
  beforeEach(() => {
    authState.isAdmin = true;
    authState.isTom = true;
    authState.token = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // THE SLURM-OFF-PATH BRANCH, IN BOTH WIRE SHAPES IT CAN ARRIVE IN.
  //
  // Shape A is what turing-api sends today: submit_build raises
  // HTTPException(502, "sbatch not found (SLURM not on PATH)"), and the Next
  // proxy lifts FastAPI's `detail` into {error, detail} while keeping the 502.
  //
  // Shape B is what it sent before: HTTP 200 carrying {"status": "error",
  // "detail": …}. That is the shape the bug lived in, and it is the shape a
  // regression in turing-api would bring back, so the hook must fail on it too —
  // this case is the only reason the `body.status === "error"` check in
  // source.ts earns its place, and deleting either makes the other pointless.
  const slurmMissing = "sbatch not found (SLURM not on PATH)";
  it.each([
    ["a 502 with the detail lifted by the proxy", { error: slurmMissing, detail: slurmMissing }, 502],
    ["a 200 whose body says status error", { status: "error", detail: slurmMissing }, 200],
  ] as const)(
    "renders the sbatch-missing error rather than 'rebuild submitted': %s",
    async (_label, body, status) => {
      const { result, posts } = await mountWithPost(async () => json(body, status));

      act(() => result.current.refresh());

      await waitFor(() =>
        expect(result.current.rebuildNote).toBe(`rebuild failed: ${slurmMissing}`),
      );
      expect(result.current.rebuildNote).not.toContain("rebuild submitted");
      expect(posts).toHaveLength(1); // the failure came from a real submit attempt
    },
  );

  // A failure with no sentence in it still has to read as a failure: the HTTP
  // status stands in for the missing detail.
  it("falls back to the status code when the failure carries no detail", async () => {
    const { result } = await mountWithPost(async () => json({}, 502));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.rebuildNote).toBe("rebuild failed: 502"));
  });

  // The other side of the branch: a real submit must still say so, with its job
  // id, so the failure checks above cannot be satisfied by failing everything.
  it("renders the job id when the submit succeeds", async () => {
    const { result } = await mountWithPost(async () =>
      json({ status: "submitted", job_id: "123456", coalesced: false }, 200),
    );

    act(() => result.current.refresh());

    await waitFor(() =>
      expect(result.current.rebuildNote).toBe("rebuild submitted (job 123456) — takes ~2 min"),
    );
  });

  // An unreachable proxy (fetch itself rejects) is a failed submit too.
  it("renders a failure when the request never completes", async () => {
    const { result } = await mountWithPost(async () => {
      throw new Error("Failed to fetch");
    });

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.rebuildNote).toBe("rebuild failed: Failed to fetch"));
  });

  // A viewer who cannot rebuild submits nothing; Refresh is only a re-fetch.
  it("submits no rebuild for a non-admin viewer", async () => {
    authState.isAdmin = false;
    authState.isTom = false;
    const { result, posts } = await mountWithPost(async () => json({}, 502));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.status).toBe("empty"));
    expect(posts).toHaveLength(0);
    expect(result.current.rebuildNote).toBeNull();
  });
});
