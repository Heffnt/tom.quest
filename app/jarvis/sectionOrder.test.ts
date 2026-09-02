import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SECTION_ORDER,
  SECTION_ROWS,
  TALL_SECTIONS,
  TALL_SECTION_ROWS,
  sectionRows,
} from "@/app/jarvis/sectionOrder";

const ROOT = path.resolve(__dirname, "../..");

async function source(relativePath: string) {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

describe("Jarvis Today section order", () => {
  it("names the ten headings of memory/<day>.md in render order", () => {
    expect([...DEFAULT_SECTION_ORDER]).toEqual([
      "Sleep",
      "Activities",
      "Meals",
      "Mood / Feeling",
      "Exercise / Body",
      "Social",
      "Substances",
      "Pending / Follow-ups",
      "Notes",
      "Evening Reconstruction",
    ]);
  });

  it("gives every tall section a name that is actually in the order", () => {
    for (const name of TALL_SECTIONS) {
      expect(DEFAULT_SECTION_ORDER).toContain(name);
    }
  });

  it("gives an unknown heading a defined height rather than none", () => {
    // A heading Tom added to the file by hand reaches the tab once GET stops
    // dropping unrecognized sections; it must still render at some height.
    expect(sectionRows("Dreams")).toBe(SECTION_ROWS);
    expect(sectionRows("Activities")).toBe(TALL_SECTION_ROWS);
  });
});

// The whole point of this module is that the list exists once. These two cases
// fail if either side ever re-declares its own copy, which is how the route and
// the tab silently disagreed before.
describe("no second copy of the section list", () => {
  it("the route reads the shared module and declares no list of its own", async () => {
    const routeSource = await source("app/api/jarvis/today/route.ts");
    expect(routeSource).toContain('from "@/app/jarvis/sectionOrder"');
    expect(routeSource).not.toMatch(/SECTION_ORDER\s*=/);
    expect(routeSource).not.toContain('"Evening Reconstruction"');
  });

  it("the tab reads the shared module, declares no list, and no literal heights", async () => {
    const tabSource = await source("app/jarvis/components/TodayTab.tsx");
    expect(tabSource).toContain('from "@/app/jarvis/sectionOrder"');
    expect(tabSource).not.toMatch(/SECTION_ORDER\s*=/);
    expect(tabSource).not.toContain('"Evening Reconstruction"');
    expect(tabSource).not.toMatch(/rows=\{[^}]*\d[^}]*\}/);
  });

  it("the shared module stays a leaf, so the client bundle stays clean", async () => {
    // TodayTab.tsx is a "use client" component. If this module ever imports
    // next/server, node:fs or requireTom — directly or through the route — the
    // browser bundle pulls them in and the build breaks.
    const moduleSource = await source("app/jarvis/sectionOrder.ts");
    expect(moduleSource).not.toMatch(/^\s*import\b/m);
    expect(moduleSource).not.toMatch(/\brequire\(/);
  });
});
