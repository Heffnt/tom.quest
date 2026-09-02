import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The point of these tests is that the provider AND model checks run on the
// server. The browser also checks the model (resolveLlm), but that runs in the
// caller's process and any client can skip it, so a check that lives only there
// is not a gate at all.

const query = vi.fn();
const mutation = vi.fn();
const setAuth = vi.fn();
const runCanvasAgent = vi.fn();

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = setAuth;
    query = query;
    mutation = mutation;
  },
}));

vi.mock("@/app/canvas/lib/canvas-agent", () => ({ runCanvasAgent }));

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/canvas/agent", {
    method: "POST",
    headers: {
      Authorization: "Bearer access-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function viewer(isTom: boolean) {
  return { _id: "user-id", role: isTom ? "tom" : "user", isAdmin: isTom, isTom };
}

describe("POST /api/canvas/agent", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
    query.mockReset();
    mutation.mockReset();
    runCanvasAgent.mockReset();
    runCanvasAgent.mockResolvedValue(undefined);
    mutation.mockResolvedValue(undefined);
  });

  it("runs the agent when the provider and model are both listed", async () => {
    query
      .mockResolvedValueOnce(viewer(false))
      .mockResolvedValueOnce([
        { canvasId: "canvas-1", kind: "user", content: "make it blue" },
      ])
      .mockResolvedValueOnce({ html: "<p>page</p>" });

    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(
      postRequest({
        chatId: "chat-1",
        provider: "anthropic",
        model: "claude-opus-4-7",
      }),
    );

    expect(response.status).toBe(200);
    expect(runCanvasAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-7",
      }),
    );
  });

  it("refuses a model the provider does not list, before starting a run", async () => {
    query.mockResolvedValueOnce(viewer(false));

    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(
      postRequest({
        chatId: "chat-1",
        provider: "openai-oauth",
        model: "gpt-9-research-preview",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Model not available for this provider",
    });
    expect(runCanvasAgent).not.toHaveBeenCalled();
    // Nothing beyond the viewer lookup happened: no chat was read, no message
    // was written, so a rejected pair leaves no trace and costs no vendor call.
    expect(query).toHaveBeenCalledTimes(1);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("refuses a Tom-only provider for a non-Tom caller", async () => {
    query.mockResolvedValueOnce(viewer(false));

    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(
      postRequest({
        chatId: "chat-1",
        provider: "openai-api",
        model: "gpt-5.5",
      }),
    );

    expect(response.status).toBe(403);
    expect(runCanvasAgent).not.toHaveBeenCalled();
  });

  it("refuses a provider that does not exist", async () => {
    query.mockResolvedValueOnce(viewer(true));

    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(
      postRequest({ chatId: "chat-1", provider: "acme", model: "gpt-5.5" }),
    );

    expect(response.status).toBe(403);
    expect(runCanvasAgent).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller before touching Convex", async () => {
    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(
      new NextRequest("http://localhost/api/canvas/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chatId: "chat-1",
          provider: "anthropic",
          model: "claude-opus-4-7",
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(runCanvasAgent).not.toHaveBeenCalled();
  });
});
