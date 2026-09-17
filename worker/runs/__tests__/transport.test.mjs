import { describe, expect, it, vi } from "vitest";

import { TRANSPORT_TRIES, causeChain, getJson, postJson, transportBackoffMs } from "../transport.mjs";

const config = { convexSiteUrl: "https://site.convex.site/", ttsKey: "tts", sessionsKey: "sessions" };

const answer = (body = { ok: true }, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// Node reports every network-level failure as this, with the real code nested.
const fetchFailed = (...codes) => {
  const error = new TypeError("fetch failed");
  let node = error;
  for (const code of codes) {
    node.cause = Object.assign(new Error(`${code} on connect`), { code });
    node = node.cause;
  }
  return error;
};

const options = (fetchImpl) => ({ fetchImpl, sleep: vi.fn(async () => {}) });

describe("run transport", () => {
  it("retries a network failure and returns the answer the retry gets", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(fetchFailed("ECONNRESET"))
      .mockResolvedValueOnce(answer({ cursor: 4 }));
    const sleep = vi.fn(async () => {});

    const result = await postJson(config, "/runs/ingest", { page: 0 }, { fetchImpl, sleep });

    expect(result).toEqual({ cursor: 4 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(transportBackoffMs(0));
  });

  it("gives up after the bounded number of tries and names the cause", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(fetchFailed("ECONNRESET"));
    const sleep = vi.fn(async () => {});

    await expect(postJson(config, "/tts/job-ok", { job: "runs-sweep" }, { fetchImpl, sleep }))
      .rejects.toThrow(/\/tts\/job-ok could not reach the site in 3 tries: fetch failed \(ECONNRESET\)/);
    expect(fetchImpl).toHaveBeenCalledTimes(TRANSPORT_TRIES);
    expect(sleep.mock.calls.flat()).toEqual([transportBackoffMs(0), transportBackoffMs(1)]);
  });

  it("names every code in a nested cause chain and says so when there is none", async () => {
    expect(causeChain(fetchFailed("UND_ERR_SOCKET", "ECONNRESET"))).toBe("UND_ERR_SOCKET <- ECONNRESET");
    expect(causeChain(new TypeError("fetch failed"))).toBe("");

    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(postJson(config, "/tts/job-ok", {}, options(fetchImpl)))
      .rejects.toThrow(/fetch failed \(cause unnamed\)/);
  });

  it("stops at a bounded depth rather than looping on a circular cause chain", () => {
    const error = new TypeError("fetch failed");
    const cause = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    cause.cause = cause;
    error.cause = cause;

    expect(causeChain(error)).toBe(Array(4).fill("ECONNRESET").join(" <- "));
  });

  it("never retries an HTTP answer, however bad, and keeps its status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer({}, 500));

    await expect(postJson(config, "/runs/ingest", {}, options(fetchImpl)))
      .rejects.toMatchObject({ message: "/runs/ingest failed with HTTP 500", status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("chooses the key and its header from the route, and a GET retries the same way", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer());
    await postJson(config, "/tts/event", { kind: "x" }, options(fetchImpl));
    await postJson(config, "/runs/ingest", { page: 0 }, options(fetchImpl));

    expect(fetchImpl.mock.calls[0][0]).toBe("https://site.convex.site/tts/event");
    expect(fetchImpl.mock.calls[0][1].headers["X-TTS-Key"]).toBe("tts");
    expect(fetchImpl.mock.calls[1][1].headers["X-Sessions-Key"]).toBe("sessions");
    expect(fetchImpl.mock.calls[1][1].headers["X-TTS-Key"]).toBeUndefined();

    const getImpl = vi.fn()
      .mockRejectedValueOnce(fetchFailed("EAI_AGAIN"))
      .mockResolvedValueOnce(answer({ request: null }));
    expect(await getJson(config, "/runs/materialize-request", options(getImpl))).toEqual({ request: null });
    expect(getImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses without the key the route needs, before reaching the network", async () => {
    const fetchImpl = vi.fn();

    await expect(postJson({ ...config, ttsKey: "" }, "/tts/event", {}, options(fetchImpl)))
      .rejects.toThrow("missing variables for TTS event");
    await expect(postJson({ ...config, sessionsKey: "" }, "/runs/ingest", {}, options(fetchImpl)))
      .rejects.toThrow("missing variables for run ingest");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("holds the give-up inside a pass to roughly ten seconds", () => {
    const waited = [...Array(TRANSPORT_TRIES - 1).keys()].reduce((sum, attempt) => sum + transportBackoffMs(attempt), 0);
    expect(waited).toBeLessThanOrEqual(10_000);
  });
});
