import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The canvas agent's rule: it runs for the admin and tom roles only.

const viewer = vi.fn();
const getMessages = vi.fn();
const runCanvasAgent = vi.fn();

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    async query(reference: unknown, args: unknown) {
      return reference === "users.viewer" ? viewer() : getMessages(reference, args);
    }
    async mutation() {}
  },
}));

vi.mock("@/convex/_generated/api", () => ({
  api: {
    users: { viewer: "users.viewer" },
    canvas: { getMessages: "canvas.getMessages", get: "canvas.get", setHtml: "canvas.setHtml", appendMessage: "canvas.appendMessage" },
  },
}));

vi.mock("@/app/canvas/lib/canvas-agent", () => ({ runCanvasAgent }));

function request(): NextRequest {
  return new NextRequest("http://localhost/api/canvas/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer placeholder" },
    body: JSON.stringify({ chatId: "chat", provider: "anthropic", model: "a-model" }),
  });
}

// users.viewer's answer for each role, as convex/authRoles.ts roleAccess gives it.
const ACCESS = {
  user: { isAdmin: false, isTom: false, isAgent: false },
  agent: { isAdmin: false, isTom: false, isAgent: true },
  admin: { isAdmin: true, isTom: false, isAgent: false },
  tom: { isAdmin: true, isTom: true, isAgent: false },
};

function account(role: keyof typeof ACCESS) {
  return { _id: `${role}-id`, name: role, email: null, role, ...ACCESS[role] };
}

describe("POST /api/canvas/agent", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://stand-in.convex.cloud");
    viewer.mockReset();
    getMessages.mockReset();
    runCanvasAgent.mockReset();
    getMessages.mockImplementation(async (reference: string) =>
      reference === "canvas.get"
        ? { html: "<p></p>" }
        : [{ canvasId: "canvas", kind: "user", content: "hello" }],
    );
    runCanvasAgent.mockResolvedValue(undefined);
  });

  it.each(["user", "agent"] as const)("refuses the %s role before reading the chat or calling a model", async (role) => {
    viewer.mockResolvedValue(account(role));
    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(request());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "The canvas agent runs for approved accounts only",
    });
    expect(getMessages).not.toHaveBeenCalled();
    expect(runCanvasAgent).not.toHaveBeenCalled();
  });

  it.each(["admin", "tom"] as const)("runs for the %s role", async (role) => {
    viewer.mockResolvedValue(account(role));
    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(runCanvasAgent).toHaveBeenCalledTimes(1);
  });

  it("refuses a request with no signed-in account", async () => {
    viewer.mockResolvedValue(null);
    const { POST } = await import("@/app/api/canvas/agent/route");
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(runCanvasAgent).not.toHaveBeenCalled();
  });
});
