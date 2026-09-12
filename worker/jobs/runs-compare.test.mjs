import { describe, expect, it, vi } from "vitest";

import { compareEndedSessions, DIFF_KEY, JOB } from "./runs-compare.mjs";

const ENV = {
  CONVEX_SITE_URL: "https://example.test",
  SESSIONS_WORKER_KEY: "sessions-test-key",
  TTS_WORKER_KEY: "tts-test-key",
};

function response(comparisons) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ comparisons }),
  };
}

describe("runs comparison job", () => {
  it("posts an empty batch request and closes the standing condition when every comparison is clean", async () => {
    const fetch = vi.fn(async () => response([{ runId: "claude:box:one", clean: true }]));
    const reportOk = vi.fn(async () => ({}));
    const reportFailed = vi.fn(async () => ({}));

    const result = await compareEndedSessions(ENV, { fetch, reportOk, reportFailed });

    expect(result).toMatchObject({ compared: 1, diffs: 0 });
    expect(fetch).toHaveBeenCalledWith("https://example.test/runs/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sessions-Key": "sessions-test-key" },
      body: "{}",
    });
    expect(reportOk).toHaveBeenCalledWith(ENV, { job: JOB, key: DIFF_KEY });
    expect(reportFailed).not.toHaveBeenCalled();
  });

  it("reports one standing failure containing counts and ids, never row text", async () => {
    const comparisons = [
      { runId: "claude:box:clean", clean: true },
      { runId: "claude:box:diff", clean: false, daemonRows: 3, fileRows: 4 },
    ];
    const reportFailed = vi.fn(async () => ({}));
    const result = await compareEndedSessions(ENV, {
      fetch: async () => response(comparisons),
      reportFailed,
      reportOk: vi.fn(),
    });

    expect(result).toMatchObject({ compared: 2, diffs: 1 });
    const body = reportFailed.mock.calls[0][1];
    expect(body).toMatchObject({ job: JOB, key: DIFF_KEY });
    expect(body.error).toContain("claude:box:diff");
    expect(JSON.stringify(body)).not.toContain("transcript");
    expect(JSON.stringify(body)).not.toContain("content");
  });

  it("refuses a response without the bounded comparisons array", async () => {
    await expect(compareEndedSessions(ENV, {
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    })).rejects.toThrow("invalid batch");
  });
});
