// The built-server Playwright script, `pnpm test:e2e:built`, is what the box's
// checks job runs for the e2e step: it must start its own `pnpm start` from
// the build the previous step wrote, never test a server already listening on
// the port. playwright.config.ts sets reuseExistingServer to !CI, so the
// script sets CI=1; with it, Playwright refuses to start when the port is
// taken instead of testing whatever answers there (the audit's finding of
// 2026-10-06 on this repository's #367).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("test:e2e:built", () => {
  it("sets CI=1 and the built server's command, and runs one worker", () => {
    const { scripts } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(scripts["test:e2e:built"]).toBe('CI=1 PLAYWRIGHT_WEBSERVER_COMMAND="pnpm start" playwright test --workers=1');
  });

  it("with CI set and the command named, the config starts `pnpm start` itself and reuses no existing server", async () => {
    vi.stubEnv("CI", "1");
    vi.stubEnv("PLAYWRIGHT_WEBSERVER_COMMAND", "pnpm start");
    try {
      const { default: config } = await import("../playwright.config.ts");
      expect(config.webServer).toMatchObject({ command: "pnpm start", reuseExistingServer: false, url: "http://127.0.0.1:3000" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
