import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debug, registerState, unregisterState } from "@/app/lib/debug";

describe("debug core", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T14:23:01.000Z"));
    debug.clear();
    unregisterState("alpha");
  });

  afterEach(() => {
    debug.clear();
    unregisterState("alpha");
    vi.useRealTimers();
  });

  it("caps the ring buffer at 200 lines", () => {
    const log = debug.scoped("test");
    for (let i = 0; i < 205; i += 1) {
      log.log(`line ${i}`);
    }

    const lines = debug.getLines();
    expect(lines).toHaveLength(200);
    expect(lines[0]).toContain("line 5");
    expect(lines.at(-1)).toContain("line 204");
  });

  it("records request and response lines with durations", async () => {
    const log = debug.scoped("api");
    const done = log.req("GET /foo", { attempt: 1 }, { defer: true });

    await vi.advanceTimersByTimeAsync(123);
    done({ status: 200 });

    const lines = debug.getLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[api] -> GET /foo attempt=1");
    expect(lines[1]).toContain("[api] <- GET /foo 123ms status=200");
  });

  it("dedupes identical successes when configured", async () => {
    const log = debug.scoped("poll");

    const first = log.req("GET /poll", undefined, { dedupeSuccessForMs: 1000, defer: true });
    first({ status: 200 });
    expect(debug.getLines()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(500);
    const second = log.req("GET /poll", undefined, { dedupeSuccessForMs: 1000, defer: true });
    second({ status: 200 });
    expect(debug.getLines()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1001);
    const third = log.req("GET /poll", undefined, { dedupeSuccessForMs: 1000, defer: true });
    third({ status: 200 });
    expect(debug.getLines()).toHaveLength(4);
  });

  it("notifies subscribers and includes registered state in snapshots", () => {
    const subscriber = vi.fn();
    const unsubscribe = debug.subscribe(subscriber);
    registerState("alpha", () => ({ status: "ok" }));

    debug.scoped("alpha").log("hello");
    unsubscribe();

    expect(subscriber).toHaveBeenCalledTimes(1);
    const snapshot = debug.snapshot();
    expect(snapshot).toContain("alpha: status=ok");
    expect(snapshot).toContain("[alpha] hello");
  });

  it("redacts sensitive fields with descriptive labels", () => {
    debug.scoped("secrets").log("payload", {
      token: "abc",
      turingApiKey: "cluster-key",
      nested: {
        password: "pw",
        privateKey: "key",
      },
    });

    const line = debug.getLines()[0];
    expect(line).toContain('token="[redacted: token]"');
    expect(line).toContain('turingApiKey="[redacted: turing-api-key]"');
    expect(line).toContain('"password":"[redacted: password]"');
    expect(line).toContain('"privateKey":"[redacted: private-key]"');
    expect(line).not.toContain("cluster-key");
  });

  it("captures console warnings in debug snapshots", () => {
    const originalWarn = console.warn;
    console.warn = vi.fn();
    try {
      debug.installConsoleCapture();
      console.warn("careful", { token: "abc" });

      const snapshot = debug.snapshot();
      expect(snapshot).toContain("console:");
      expect(snapshot).toContain("warn: careful");
      expect(snapshot).toContain('"token":"[redacted: token]"');
      expect(snapshot).not.toContain("abc");
    } finally {
      console.warn = originalWarn;
    }
  });
});
