import { defineConfig, devices } from "@playwright/test";

// Fill process.env from secrets/e2e.env (gitignored; template at
// secrets/e2e.env.example) before specs are collected. Without this the six
// E2E credential variables can only be exported by hand in the shell, because
// pnpm loads no env file into the process it runs and .env.local is read by
// Next.js for itself, not by this process. Variables already set in the shell
// win. See README.md, "End-to-end tests", for what each variable turns on.
// Do not reach for `import.meta.url` to build the path: Playwright compiles
// this config to CommonJS, `import.meta` survives that compilation as ES module
// syntax, and Node then loads the file as an ES module and dies on `exports is
// not defined`. `__dirname` is the form that works here.
import path from "node:path";

import { loadEnvFile } from "./scripts/e2e-env.mjs";

loadEnvFile(path.join(__dirname, "secrets", "e2e.env"));

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: process.env.PLAYWRIGHT_WEBSERVER_COMMAND ?? "corepack pnpm dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
