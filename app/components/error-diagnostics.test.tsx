// The error boundary (app/error.tsx) names the failed call, the server's
// message, the build and the record it talks to. The case is the one of
// Oct 6, 2026: a preview build called a Convex function the production
// record did not have yet, and the page said only "Something broke."

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const captureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException: (e: unknown) => captureException(e) }));

import ErrorPage from "../error";
import { diagnoseError } from "../lib/error-diagnosis";

const UNKNOWN_FUNCTION_MESSAGE =
  "[CONVEX Q(agents:sessionsPage)] [Request ID: 3f9c1a2b7d4e5f60] Server Error\n" +
  "Could not find public function for 'agents:sessionsPage'. Did you forget to run `npx convex dev` or `npx convex deploy`?\n" +
  "\n  Called by client";

describe("error boundary diagnostics", () => {
  beforeEach(() => {
    vi.stubEnv("BUILD_COMMIT_SHA", "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    vi.stubEnv("BUILD_BRANCH", "redesign/sessions-page");
    vi.stubEnv("BUILD_DEPLOY_ENV", "preview");
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example-record-123.convex.cloud");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("names the unknown function, the server's message, the build sha and the record host", () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error(UNKNOWN_FUNCTION_MESSAGE)} reset={reset} />);
    const page = screen.getByTestId("error-diagnostics");
    const text = page.textContent ?? "";

    expect(text).toContain("query agents:sessionsPage");
    expect(text).toContain("Could not find public function for 'agents:sessionsPage'");
    expect(text).toContain("request 3f9c1a2b7d4e5f60");
    expect(text).toContain("a1b2c3d");
    expect(text).toContain("redesign/sessions-page");
    expect(text).toContain("example-record-123.convex.cloud");
    expect(text).toContain("ahead of the record");
    expect(text).toMatch(/Eastern/);
    expect(text).not.toMatch(/something broke|if this keeps happening/i);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "retry" })).toBeTruthy();
  });

  it("tells a production page that meets an unknown function to reload, not to merge", () => {
    const d = diagnoseError(new Error(UNKNOWN_FUNCTION_MESSAGE), {
      route: "/agents",
      at: 0,
      build: { sha: "a1b2c3d", branch: "main", deployEnv: "production" },
      recordHost: "example-record-123.convex.cloud",
    });
    expect(d.kind).toBe("unknown-function");
    expect(d.action).toContain("older build than the record");
    expect(d.action).toContain("reloading the page");
    expect(d.action).not.toContain("ahead of the record");
  });

  it("reports a non-Convex error by its route and digest", () => {
    const err = Object.assign(new Error("boom"), { digest: "1234567" });
    const d = diagnoseError(err, {
      route: "/agents",
      at: Date.parse("2026-10-06T23:23:00Z"),
      build: { sha: "a1b2c3d", branch: "main", deployEnv: "production" },
      recordHost: "example-record-123.convex.cloud",
    });
    expect(d.kind).toBe("page");
    expect(d.failed).toBe("route /agents");
    expect(d.request).toContain("digest 1234567");
    expect(d.message).toBe("boom");
    expect(d.time).toBe("Tue Oct 6, 7:23 pm Eastern");
  });

  it("renders a ConvexError whose data holds a bigint (a Convex Int64)", () => {
    const err = Object.assign(
      new Error("[CONVEX M(todos:archive)] [Request ID: abc] Server Error\n\n  Called by client"),
      { data: { code: "stale", version: BigInt("9007199254740993") } },
    );
    const d = diagnoseError(err, {
      route: "/jarvis",
      at: 0,
      build: { sha: null, branch: null, deployEnv: null },
      recordHost: null,
    });
    expect(d.message).toContain('"version":"9007199254740993"');
  });

  it("names a failing Convex mutation without calling it unknown", () => {
    const d = diagnoseError(
      new Error("[CONVEX M(todos:archive)] [Request ID: abc] Server Error\nUncaught Error: todo not found\n\n  Called by client"),
      { route: "/jarvis", at: 0, build: { sha: null, branch: null, deployEnv: null }, recordHost: null },
    );
    expect(d.kind).toBe("convex-function");
    expect(d.failed).toBe("mutation todos:archive");
    expect(d.message).toBe("Server Error\nUncaught Error: todo not found");
  });
});
