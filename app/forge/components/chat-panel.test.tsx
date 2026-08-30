// Regression test: ChatPanel must not fetch a serve status before the Convex
// job query has resolved the run identifier. It used to substitute the segment
// "_" for the missing identifier, which the Turing API answers 404 for and the
// proxy rewraps as a 502, painting "serve status: ..." on every mount.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import ChatPanel from "./chat-panel";

const jobQuery = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("convex/react", () => ({
  // getJob resolves first in this component; listMessages returns [] so the
  // transcript renders. Both go through the same useQuery, distinguished by the
  // argument shape (getJob takes { id }, listMessages takes { jobId }).
  useQuery: (_ref: unknown, args: Record<string, unknown>) =>
    "id" in args ? jobQuery.value : [],
  useMutation: () => vi.fn(),
}));

vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ token: "test-token" }),
}));

describe("ChatPanel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    jobQuery.value = undefined;
    fetchMock = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("issues no request while the run identifier is unresolved", async () => {
    render(<ChatPanel jobId={"job1" as Id<"forgeJobs">} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Chat")).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests the serve status only once the run identifier resolves", async () => {
    const { rerender } = render(
      <ChatPanel jobId={"job1" as Id<"forgeJobs">} onClose={() => {}} />,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    jobQuery.value = { runId: "run-abc", serveStatus: "starting", name: "job" };
    rerender(<ChatPanel jobId={"job1" as Id<"forgeJobs">} onClose={() => {}} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/turing/forge/serve/run-abc");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("/forge/serve/_");
  });
});
