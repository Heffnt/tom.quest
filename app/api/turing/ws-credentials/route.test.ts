import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Terminal access is ADMIN-level, not Tom-only. Mocking the module with only
// requireAdmin is deliberate: if this route is ever "tightened" to requireTom,
// that import resolves to undefined here and these tests fail loudly.
const requireAdmin = vi.fn();
const signWsToken = vi.fn();

vi.mock("@/app/lib/convex-server", () => ({
  requireAdmin,
}));

vi.mock("@/app/lib/turing", () => ({
  signWsToken,
}));

function getRequest(session: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/turing/ws-credentials?session=${encodeURIComponent(session)}`,
    { headers: { Authorization: "Bearer access-token" } },
  );
}

describe("GET /api/turing/ws-credentials", () => {
  beforeEach(() => {
    requireAdmin.mockReset();
    signWsToken.mockReset();
    requireAdmin.mockResolvedValue({ _id: "admin-id", role: "admin", isAdmin: true, isTom: false });
    signWsToken.mockReturnValue({ token: "signed", expiresAt: 1 });
  });

  it("mints a terminal token for a plain admin", async () => {
    const { GET } = await import("@/app/api/turing/ws-credentials/route");
    const response = await GET(getRequest("sess-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ token: "signed", expiresAt: 1 });
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(signWsToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "admin-id", sessionName: "sess-1" }),
    );
  });

  it("returns the auth failure untouched when the caller is not an admin", async () => {
    requireAdmin.mockResolvedValue(
      new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }),
    );
    const { GET } = await import("@/app/api/turing/ws-credentials/route");
    const response = await GET(getRequest("sess-1"));

    expect(response.status).toBe(403);
    expect(signWsToken).not.toHaveBeenCalled();
  });

  it("rejects a missing session name before signing anything", async () => {
    const { GET } = await import("@/app/api/turing/ws-credentials/route");
    const response = await GET(getRequest(""));

    expect(response.status).toBe(400);
    expect(signWsToken).not.toHaveBeenCalled();
  });
});
