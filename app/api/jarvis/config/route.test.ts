import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const isTom = vi.fn();

vi.mock("@/app/lib/supabase", () => ({
  createServerSupabaseClient: () => ({
    auth: {
      getUser,
    },
  }),
}));

vi.mock("@/app/lib/turing", () => ({
  isTom,
}));

describe("GET /api/jarvis/config", () => {
  beforeEach(() => {
    getUser.mockReset();
    isTom.mockReset();
    getUser.mockResolvedValue({ data: { user: { id: "tom-id" } } });
    isTom.mockReturnValue(true);
    process.env.OPENCLAW_GATEWAY_URL = "wss://jarvis-1.tail2afba8.ts.net";
    process.env.JARVIS_GATEWAY_PASSWORD = "shared-password";
    process.env.JARVIS_DEVICE_ID = "shared-device-id";
    process.env.JARVIS_DEVICE_PUBLIC_KEY = "shared-public-key";
    process.env.JARVIS_DEVICE_PRIVATE_KEY = "shared-private-key";
  });

  it("returns the configured gateway password and shared device identity for Tom", async () => {
    const { GET } = await import("@/app/api/jarvis/config/route");
    const response = await GET(new Request("http://localhost/api/jarvis/config", {
      headers: {
        Authorization: "Bearer access-token",
      },
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      gatewayUrl: "wss://jarvis-1.tail2afba8.ts.net",
      gatewayPassword: "shared-password",
      gatewayDeviceIdentity: {
        deviceId: "shared-device-id",
        publicKey: "shared-public-key",
        privateKey: "shared-private-key",
      },
    });
    expect(getUser).toHaveBeenCalledWith("access-token");
  });

  it("fails when the shared gateway password is missing", async () => {
    delete process.env.JARVIS_GATEWAY_PASSWORD;
    const { GET } = await import("@/app/api/jarvis/config/route");
    const response = await GET(new Request("http://localhost/api/jarvis/config", {
      headers: {
        Authorization: "Bearer access-token",
      },
    }) as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Gateway password not configured",
    });
  });

  it("fails when the shared gateway identity is only partially configured", async () => {
    delete process.env.JARVIS_DEVICE_PRIVATE_KEY;
    const { GET } = await import("@/app/api/jarvis/config/route");
    const response = await GET(new Request("http://localhost/api/jarvis/config", {
      headers: {
        Authorization: "Bearer access-token",
      },
    }) as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Shared Jarvis gateway identity is incomplete",
    });
  });
});
