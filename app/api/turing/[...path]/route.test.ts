import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireAdmin = vi.fn();
const forwardToTuringApi = vi.fn();

vi.mock("@/app/lib/convex-server", () => ({
  requireAdmin,
}));

vi.mock("@/app/lib/turing", () => ({
  forwardToTuringApi,
}));

function postRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/turing/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer access-token" },
    body: JSON.stringify(body),
  });
}

function ctx(path: string[]) {
  return { params: Promise.resolve({ path }) };
}

describe("POST /api/turing/allocate gpupool guard", () => {
  beforeEach(() => {
    requireAdmin.mockReset();
    forwardToTuringApi.mockReset();
    requireAdmin.mockResolvedValue({ _id: "admin-id", role: "admin", isAdmin: true });
  });

  it("rejects a reserved gpupool: job_name without forwarding upstream", async () => {
    const { POST } = await import("@/app/api/turing/[...path]/route");
    const response = await POST(
      postRequest("allocate", { job_name: "gpupool:nvidia_a100:deadbeef", gpu_type: "nvidia_a100" }),
      ctx(["allocate"]),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Job name prefix 'gpupool:' is reserved for the GPU pool reconciler.",
    });
    expect(forwardToTuringApi).not.toHaveBeenCalled();
  });

  it("forwards a normal allocate request to the Turing API", async () => {
    forwardToTuringApi.mockResolvedValue(
      new Response(JSON.stringify({ success: true, job_ids: ["123"], errors: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await import("@/app/api/turing/[...path]/route");
    const response = await POST(
      postRequest("allocate", { job_name: "allocation", gpu_type: "nvidia_a100" }),
      ctx(["allocate"]),
    );

    expect(response.status).toBe(200);
    expect(forwardToTuringApi).toHaveBeenCalledTimes(1);
  });
});
