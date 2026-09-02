import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireAdmin = vi.fn();
const requireAdminOrAgent = vi.fn();
const forwardToTuringApi = vi.fn();

vi.mock("@/app/lib/convex-server", () => ({
  requireAdmin,
  requireAdminOrAgent,
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
    requireAdminOrAgent.mockReset();
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

// An upstream failure is only useful if the sentence explaining it survives the
// hop. turing-api reports every failure as {"detail": "<message>"}; the proxy used
// to forward that whole envelope as one string in `error`, so a caller reading
// `detail` got undefined and rendered a bare status number instead of the reason.
describe("the Turing proxy carries the upstream reason through", () => {
  beforeEach(() => {
    requireAdmin.mockReset();
    requireAdminOrAgent.mockReset();
    forwardToTuringApi.mockReset();
    requireAdmin.mockResolvedValue({ _id: "admin-id", role: "admin", isAdmin: true });
  });

  it("lifts a FastAPI detail out of a failed response", async () => {
    forwardToTuringApi.mockResolvedValue(
      new Response(JSON.stringify({ detail: "sbatch not found (SLURM not on PATH)" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await import("@/app/api/turing/[...path]/route");

    const response = await POST(
      postRequest("boolback-snapshot", {}),
      ctx(["boolback-snapshot"]),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "sbatch not found (SLURM not on PATH)",
      detail: "sbatch not found (SLURM not on PATH)",
    });
  });

  it("passes a non-JSON error body through unchanged, with no detail invented", async () => {
    forwardToTuringApi.mockResolvedValue(
      new Response("upstream exploded", {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await import("@/app/api/turing/[...path]/route");

    const response = await POST(postRequest("allocate", { job_name: "x" }), ctx(["allocate"]));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "upstream exploded" });
  });
});

// The gate is per METHOD here, and this is the block that says so. One
// requireAdmin used to sit in front of GET, POST and DELETE alike, so any
// account that could LOOK at /turing could also allocate GPUs and cancel
// running jobs — including a TTS session, which browses as a real signed-in
// account. These tests fail if the two ever collapse back into one.
describe("the Turing proxy gates reads and writes separately", () => {
  const ok = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  function request(path: string, method: "GET" | "POST" | "DELETE"): NextRequest {
    return new NextRequest(`http://localhost/api/turing/${path}`, {
      method,
      headers: { Authorization: "Bearer access-token" },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
  }

  beforeEach(() => {
    requireAdmin.mockReset();
    requireAdminOrAgent.mockReset();
    forwardToTuringApi.mockReset();
  });

  it("sends GET through the read gate, naming the Turing surface", async () => {
    requireAdminOrAgent.mockResolvedValue({ _id: "agent-id", role: "agent", isAgent: true });
    forwardToTuringApi.mockResolvedValue(ok());
    const { GET } = await import("@/app/api/turing/[...path]/route");

    const response = await GET(request("gpus", "GET"), ctx(["gpus"]));

    expect(response.status).toBe(200);
    expect(requireAdminOrAgent).toHaveBeenCalledWith(expect.anything(), "Turing");
    expect(requireAdmin).not.toHaveBeenCalled();
  });

  // The two that change cluster state. If either ever asked the read gate, an
  // account whose whole purpose is looking at a page could cancel a training
  // job — the exact harm the `agent` role exists to remove.
  it.each([
    ["POST", "allocate"],
    ["DELETE", "jobs/12345"],
  ] as const)("keeps %s on requireAdmin", async (method, path) => {
    requireAdmin.mockResolvedValue({ _id: "admin-id", role: "admin", isAdmin: true });
    forwardToTuringApi.mockResolvedValue(ok());
    const route = await import("@/app/api/turing/[...path]/route");

    await route[method](request(path, method), ctx(path.split("/")));

    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(requireAdminOrAgent).not.toHaveBeenCalled();
  });

  // A refusal must stop the request, not merely be recorded: nothing reaches
  // the cluster API.
  it.each([
    ["POST", "allocate"],
    ["DELETE", "jobs/12345"],
  ] as const)("forwards nothing upstream when %s is refused", async (method, path) => {
    requireAdmin.mockResolvedValue(
      Response.json({ error: "Admin access required" }, { status: 403 }),
    );
    const route = await import("@/app/api/turing/[...path]/route");

    const response = await route[method](request(path, method), ctx(path.split("/")));

    expect(response.status).toBe(403);
    expect(forwardToTuringApi).not.toHaveBeenCalled();
  });
});
