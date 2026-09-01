// /turing/terminal-harness is a test fixture, not a product page: it mounts the
// terminal modal for e2e/terminal-surfaces.spec.ts without the Convex admin
// login the jobs table needs. These cases fail if it ever becomes reachable in
// production — if the environment guard is dropped, if the guard moves to a
// NEXT_PUBLIC_ variable (which is compiled into the browser bundle and so is
// visible to anyone), if the page stops being evaluated per request, or if the
// route is added to the navigation metadata.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = process.cwd();
const PAGE = fs.readFileSync(path.join(ROOT, "app/turing/terminal-harness/page.tsx"), "utf8");
const ROUTES = fs.readFileSync(path.join(ROOT, "app/components/page-routes.ts"), "utf8");

describe("the terminal-modal test route", () => {
  it("answers 404 unless TERMINAL_HARNESS is exactly \"1\"", () => {
    expect(PAGE).toMatch(/process\.env\.TERMINAL_HARNESS !== "1"/);
    expect(PAGE).toMatch(/notFound\(\)/);
  });

  it("gates on a server-only variable, never one shipped to the browser", () => {
    expect(PAGE).not.toMatch(/NEXT_PUBLIC_/);
  });

  it("is evaluated per request, so a build machine's environment cannot bake it in", () => {
    expect(PAGE).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("is absent from the navigation metadata", () => {
    expect(ROUTES).not.toMatch(/terminal-harness/);
  });
});
