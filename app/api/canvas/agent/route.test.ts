import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getFunctionName } from "convex/server";

// The canvas agent spends model calls on this deployment's provider keys, and
// /canvas is open to every signed-in account. The route checked only that the
// provider was allowed for the viewer's role, so any signed-in account ran it.
// It now requires Tom (the viewer's isTom). The route runs here over a Convex
// client whose viewer the test chooses; the agent is
// a mock that records whether it ran. The provider asked for, Anthropic, is
// one every role may pick, so only the Tom gate refuses.
const viewer = vi.fn();
const calls: string[] = [];
const runCanvasAgent = vi.fn();

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    async query(ref: unknown) {
      const name = getFunctionName(ref as never);
      calls.push(name);
      if (name === "users:viewer") return viewer();
      if (name === "canvas:getMessages") return [{ kind: "user", content: "make it blue", canvasId: "canvas-1" }];
      if (name === "canvas:get") return { html: "<p>hi</p>" };
      throw new Error(`unexpected query ${name}`);
    }
    async mutation(ref: unknown) {
      calls.push(getFunctionName(ref as never));
    }
  },
}));

vi.mock("@/app/canvas/lib/canvas-agent", () => ({ runCanvasAgent }));

const account = (role: "user" | "admin" | "tom") => ({
  _id: `${role}-id`, name: role, email: null, role,
  isAdmin: role === "admin" || role === "tom", isTom: role === "tom", isAgent: false,
});

function post(headers: Record<string, string> = { Authorization: "Bearer access-token" }): NextRequest {
  return new NextRequest("http://localhost/api/canvas/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ chatId: "chat-1", provider: "anthropic", model: "claude-sonnet-4-6" }),
  });
}

describe("POST /api/canvas/agent", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
    viewer.mockReset();
    runCanvasAgent.mockReset();
    runCanvasAgent.mockResolvedValue(undefined);
    calls.length = 0;
  });

  it.each(["user", "admin"] as const)("refuses a signed-in %s account with 403, and runs no agent and reads no chat", async (role) => {
    viewer.mockResolvedValue(account(role));
    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(post());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Tom access required" });
    expect(runCanvasAgent).not.toHaveBeenCalled();
    expect(calls).toEqual(["users:viewer"]);
  });

  it("refuses a token the record does not know with 401", async () => {
    viewer.mockResolvedValue(null);
    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(post());
    expect(response.status).toBe(401);
    expect(runCanvasAgent).not.toHaveBeenCalled();
  });

  it("takes the Bearer scheme in any case and spacing, as before", async () => {
    viewer.mockResolvedValue(account("tom"));
    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(post({ Authorization: "bearer   access-token" }));
    expect(response.status).toBe(200);
    expect(runCanvasAgent).toHaveBeenCalledTimes(1);
  });

  it("refuses a request with no token with 401", async () => {
    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(post({}));
    expect(response.status).toBe(401);
    expect(viewer).not.toHaveBeenCalled();
    expect(runCanvasAgent).not.toHaveBeenCalled();
  });

  it("runs the agent for Tom", async () => {
    viewer.mockResolvedValue(account("tom"));
    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(runCanvasAgent).toHaveBeenCalledTimes(1);
    expect(runCanvasAgent.mock.calls[0][0]).toMatchObject({ initialHtml: "<p>hi</p>", userMessage: "make it blue", provider: "anthropic", model: "claude-sonnet-4-6" });
  });
});
