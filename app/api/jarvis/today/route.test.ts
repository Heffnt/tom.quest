// The Today round trip, read as bytes: GET a day file, hand the payload's own
// fields straight back to PUT (which is exactly what TodayTab does), and
// compare the file on disk to what it was. Before this route read the file's
// own heading order, that round trip REORDERED the day permanently — a file
// holding only "## Sleep" came back as Sleep, Notes, Activities, … and the
// save wrote that order down.
//
// The route reaches the filesystem through exactly one function —
// resolveWorkspacePath, which resolves against the hardcoded WORKSPACE_ROOT
// (_utils.ts) — so that function is the only thing redirected here.
// parseMarkdownSections, buildMarkdownSections and pathExists stay real: they
// are what is under test.

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));
const requireTom = vi.fn();
vi.mock("@/app/lib/convex-server", () => ({ requireTom }));
vi.mock("@/app/api/jarvis/_utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/api/jarvis/_utils")>();
  return {
    ...actual,
    resolveWorkspacePath: (rel: string) => path.join(state.root, rel.replace(/^\/+/, "")),
  };
});

const DAY = "2026-09-01";
const filePath = (day = DAY) => path.join(state.root, "memory", `${day}.md`);

async function route() {
  return import("@/app/api/jarvis/today/route");
}

async function get(day = DAY) {
  const { GET } = await route();
  const response = await GET(
    new NextRequest(`http://localhost/api/jarvis/today?date=${day}`),
  );
  return (await response.json()) as {
    date: string;
    title: string;
    orderedSections: string[];
    missingSections: string[];
    sections: Record<string, string>;
  };
}

async function put(body: Record<string, unknown>) {
  const { PUT } = await route();
  return PUT(
    new NextRequest("http://localhost/api/jarvis/today", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** One load-and-save exactly as TodayTab performs it. Returns the file after. */
async function loadAndSave(day = DAY) {
  const payload = await get(day);
  await put({
    date: payload.date,
    title: payload.title,
    orderedSections: payload.orderedSections,
    missingSections: payload.missingSections,
    sections: payload.sections,
  });
  return fs.readFile(filePath(day), "utf8");
}

async function write(content: string, day = DAY) {
  await fs.writeFile(filePath(day), content, "utf8");
}

beforeEach(async () => {
  requireTom.mockReset();
  requireTom.mockResolvedValue({ _id: "tom-id", role: "tom", isTom: true });
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), "today-route-"));
  await fs.mkdir(path.join(state.root, "memory"), { recursive: true });
});

// The shape buildMarkdownSections emits, and so the shape a settled day file
// has: title, blank line, then each heading followed directly by its body and
// one blank line. A file written any other way is normalized on the first save
// (the cases under NORMALIZED below) — what must never happen is a file that
// keeps changing.
const SLEEP_ONLY = `# ${DAY}\n\n## Sleep\n- 11:30 PM — asleep, ~7h\n`;

// Files a read-then-save must leave byte-identical. Each is a shape the route
// used to change on sight.
const UNCHANGED: Array<[string, string]> = [
  ["a file with one heading", SLEEP_ONLY],
  [
    "a file whose own order is not the default order",
    `# ${DAY}\n\n## Notes\n- a thought\n\n## Sleep\n- 11:30 PM — asleep, ~7h\n`,
  ],
  [
    "a file with text above the first heading",
    `# ${DAY}\n\nloose line under the title\n\n## Sleep\n- 11:30 PM — asleep, ~7h\n`,
  ],
  [
    "a file carrying a heading outside the default set",
    `# ${DAY}\n\n## Sleep\n- 11:30 PM — asleep, ~7h\n\n## Dreams\n- flying again\n`,
  ],
  [
    "a file with a title and a stray line but no headings",
    `# ${DAY}\n\nnothing happened yet\n`,
  ],
];

describe("the Today round trip", () => {
  for (const [name, content] of UNCHANGED) {
    it(`leaves ${name} byte-identical`, async () => {
      await write(content);
      expect(await loadAndSave()).toBe(content);
    });
  }

  it("leaves a file holding every default heading byte-identical", async () => {
    const all = await (async () => {
      // Built from the route's own default order, so the fixture cannot drift
      // from it.
      const names = (await get()).missingSections;
      return `# ${DAY}\n\n` + names.map((n) => `## ${n}\n- x\n`).join("\n");
    })();
    await write(all);
    expect(await loadAndSave()).toBe(all);
  });

  // The shapes that DO change are normalizations, not losses. What matters is
  // that they change ONCE: a file the round trip keeps rewriting is a file that
  // never settles.
  const NORMALIZED: Array<[string, string]> = [
    ["a file with no title line", `## Sleep\n- 11:30 PM — asleep, ~7h\n`],
    ["a blank line under a heading", `# ${DAY}\n\n## Sleep\n\n- 11:30 PM — asleep, ~7h\n`],
    ["CRLF line endings", SLEEP_ONLY.replace(/\n/g, "\r\n")],
    ["a duplicate heading", `# ${DAY}\n\n## Sleep\n- one\n\n## Sleep\n- two\n`],
    ["a heading with trailing spaces", `# ${DAY}\n\n## Sleep   \n- one\n`],
    ["a zero-byte file", ""],
  ];

  for (const [name, content] of NORMALIZED) {
    it(`settles ${name} after a single save`, async () => {
      await write(content);
      const first = await loadAndSave();
      const second = await loadAndSave();
      const third = await loadAndSave();
      expect(second).toBe(first);
      expect(third).toBe(second);
    });
  }

  it("keeps a heading outside the default set, and its body", async () => {
    await write(
      `# ${DAY}\n\n## Sleep\n- 11:30 PM — asleep, ~7h\n\n## Dreams\n- flying again\n`,
    );
    const payload = await get();
    expect(payload.orderedSections).toContain("Dreams");
    expect(payload.sections["Dreams"]).toBe("- flying again");
    expect(await loadAndSave()).toContain("- flying again");
  });

  it("does not reorder the day when the client sends no order", async () => {
    await write(`# ${DAY}\n\n## Notes\n- a thought\n\n## Sleep\n- slept\n`);
    await put({ date: DAY, sections: {} });
    const after = await fs.readFile(filePath(), "utf8");
    expect(after.indexOf("## Notes")).toBeLessThan(after.indexOf("## Sleep"));
  });

  it("does not erase headings a partial write leaves out", async () => {
    await write(SLEEP_ONLY);
    await put({ date: DAY, sections: { Notes: "- remembered something" } });
    const after = await fs.readFile(filePath(), "utf8");
    expect(after).toContain("- 11:30 PM — asleep, ~7h");
    expect(after).toContain("- remembered something");
  });

  it("empties a heading sent as an empty string", async () => {
    await write(SLEEP_ONLY);
    await put({ date: DAY, sections: { Sleep: "" } });
    const after = await fs.readFile(filePath(), "utf8");
    expect(after).toContain("## Sleep");
    expect(after).not.toContain("asleep");
  });
});

describe("typing into a heading the file does not have", () => {
  it("adds only that heading, at its default slot", async () => {
    await write(SLEEP_ONLY);
    const payload = await get();
    await put({
      date: DAY,
      title: payload.title,
      orderedSections: payload.orderedSections,
      missingSections: payload.missingSections,
      sections: { ...payload.sections, Meals: "- 1 PM — burrito" },
    });
    const after = await fs.readFile(filePath(), "utf8");
    expect(after).toBe(`# ${DAY}\n\n## Sleep\n- 11:30 PM — asleep, ~7h\n\n## Meals\n- 1 PM — burrito\n`);
  });

  it("adds nothing for a box left empty", async () => {
    await write(SLEEP_ONLY);
    const payload = await get();
    expect(payload.missingSections.length).toBeGreaterThan(0);
    await put({
      date: DAY,
      title: payload.title,
      orderedSections: payload.orderedSections,
      missingSections: payload.missingSections,
      sections: payload.sections,
    });
    expect(await fs.readFile(filePath(), "utf8")).toBe(SLEEP_ONLY);
  });

  it("lands in the same place whichever order the missing headings arrive in", async () => {
    await write(SLEEP_ONLY);
    const payload = await get();
    const send = (missing: string[]) => ({
      date: DAY,
      title: payload.title,
      orderedSections: payload.orderedSections,
      missingSections: missing,
      sections: { ...payload.sections, Meals: "- burrito", Activities: "- walked" },
    });
    await put(send(payload.missingSections));
    const forward = await fs.readFile(filePath(), "utf8");
    await write(SLEEP_ONLY);
    await put(send([...payload.missingSections].reverse()));
    expect(await fs.readFile(filePath(), "utf8")).toBe(forward);
  });
});

describe("a day with no file yet", () => {
  it("offers every default heading as a box", async () => {
    const payload = await get();
    expect(payload.orderedSections).toEqual([]);
    expect(payload.missingSections.length).toBe(10);
  });

  it("writes only the headings that have content", async () => {
    const payload = await get();
    await put({
      date: DAY,
      title: payload.title,
      orderedSections: payload.orderedSections,
      missingSections: payload.missingSections,
      sections: { ...payload.sections, Sleep: "- 11:30 PM — asleep, ~7h" },
    });
    expect(await fs.readFile(filePath(), "utf8")).toBe(SLEEP_ONLY);
  });
});
