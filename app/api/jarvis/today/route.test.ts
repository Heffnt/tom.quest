import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const requireTom = vi.fn();

vi.mock("@/app/lib/convex-server", () => ({
  requireTom,
}));

// The route reads and writes real files under the openclaw workspace. These
// tests point WORKSPACE_ROOT at a temporary directory through the
// JARVIS_WORKSPACE_ROOT override (app/api/jarvis/_utils.ts). That value is read
// once when the module loads, so every test resets the module registry and
// imports the route dynamically after setting the variable.
const DAY = "2026-05-09";

const KNOWN_SECTIONS = [
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
];

let workspace: string;

async function loadRoute() {
  return import("@/app/api/jarvis/today/route");
}

function dayFile() {
  return path.join(workspace, "memory", `${DAY}.md`);
}

async function writeDayFile(contents: string) {
  await fs.writeFile(dayFile(), contents, "utf8");
}

async function readDayFile() {
  return fs.readFile(dayFile(), "utf8");
}

type TodayPayload = {
  date: string;
  title: string;
  orderedSections: string[];
  sections: Record<string, string>;
};

async function get() {
  const { GET } = await loadRoute();
  const response = await GET(new Request(`http://localhost/api/jarvis/today?date=${DAY}`) as never);
  return { response, payload: (await response.json()) as TodayPayload };
}

async function put(body: Record<string, unknown>) {
  const { PUT } = await loadRoute();
  return PUT(new Request("http://localhost/api/jarvis/today", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never);
}

/** The payload the tab sends today: the ten known sections and nothing else. */
function knownSectionsPayload(sections: Record<string, string>) {
  return {
    date: DAY,
    title: DAY,
    orderedSections: KNOWN_SECTIONS,
    sections: Object.fromEntries(KNOWN_SECTIONS.map((name) => [name, sections[name] ?? ""])),
  };
}

describe("/api/jarvis/today round trip", () => {
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-today-"));
    await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
    process.env.JARVIS_WORKSPACE_ROOT = workspace;
    requireTom.mockReset();
    requireTom.mockResolvedValue({ _id: "tom-id", role: "tom", isTom: true });
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.JARVIS_WORKSPACE_ROOT;
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("exposes a hand-added section that is not one of the ten known names", async () => {
    // Regression: GET filtered the file down to DEFAULT_SECTION_ORDER, so the
    // tab never saw "Dreams" and could not send it back.
    await writeDayFile(`# ${DAY}\n## Sleep\n- 7h\n\n## Dreams\n- flying\n`);

    const { response, payload } = await get();

    expect(response.status).toBe(200);
    expect(payload.orderedSections).toEqual([...KNOWN_SECTIONS, "Dreams"]);
    expect(payload.sections["Dreams"]).toBe("- flying");
    expect(payload.sections["Sleep"]).toBe("- 7h");
  });

  it("keeps a hand-added section on disk when the request carries only the ten known names", async () => {
    // Regression: PUT rewrote the whole file from the request, so a save from a
    // tab that only knew the ten names deleted "Dreams" silently.
    await writeDayFile(`# ${DAY}\n## Sleep\n- 7h\n\n## Dreams\n- flying\n`);

    const response = await put(knownSectionsPayload({ Sleep: "- 8h" }));
    expect(response.status).toBe(200);

    const contents = await readDayFile();
    expect(contents).toContain("## Dreams");
    expect(contents).toContain("- flying");
    expect(contents).toContain("- 8h");
  });

  it("leaves an unknown section in its position on disk rather than moving it to the end", async () => {
    await writeDayFile(`# ${DAY}\n## Sleep\n- 7h\n\n## Dreams\n- flying\n\n## Notes\n- note\n`);

    await put(knownSectionsPayload({ Sleep: "- 8h", Notes: "- note" }));

    const contents = await readDayFile();
    expect(contents.indexOf("## Dreams")).toBeGreaterThan(contents.indexOf("## Sleep"));
    expect(contents.indexOf("## Dreams")).toBeLessThan(contents.indexOf("## Notes"));
  });

  it("does not relocate text written before the first heading into Notes", async () => {
    // parseMarkdownSections used to fold the preamble into the "Notes" bucket,
    // so a save moved it under `## Notes` and merged it with the real notes.
    await writeDayFile(`# ${DAY}\nwoke up disoriented\n\n## Sleep\n- 7h\n\n## Notes\n- note\n`);

    const { payload } = await get();
    expect(payload.sections["Notes"]).toBe("- note");

    await put(knownSectionsPayload({ Sleep: "- 7h", Notes: "- note" }));

    const contents = await readDayFile();
    expect(contents.indexOf("woke up disoriented")).toBeLessThan(contents.indexOf("## Sleep"));
    expect(contents.match(/woke up disoriented/g)).toHaveLength(1);
  });

  it("leaves a section the request lists but carries no body for untouched", async () => {
    await writeDayFile(`# ${DAY}\n## Sleep\n- 7h\n`);

    await put({
      date: DAY,
      orderedSections: KNOWN_SECTIONS,
      sections: { Notes: "- added" },
    });

    const contents = await readDayFile();
    expect(contents).toContain("- 7h");
    expect(contents).toContain("- added");
  });

  it("falls back to the title already in the file before the date default", async () => {
    await writeDayFile(`# Friday ${DAY}\n## Sleep\n- 7h\n`);

    await put({
      date: DAY,
      orderedSections: KNOWN_SECTIONS,
      sections: { Sleep: "- 8h" },
    });

    const contents = await readDayFile();
    expect(contents.startsWith(`# Friday ${DAY}\n`)).toBe(true);
  });

  it("creates the day file with the ten known sections when none exists", async () => {
    const response = await put(knownSectionsPayload({ Sleep: "- 7h" }));
    expect(response.status).toBe(200);

    const contents = await readDayFile();
    expect(contents.startsWith(`# ${DAY}\n`)).toBe(true);
    for (const name of KNOWN_SECTIONS) {
      expect(contents).toContain(`## ${name}`);
    }
  });

  it("rejects a request with no sections", async () => {
    const response = await put({ date: DAY });
    expect(response.status).toBe(400);
  });
});
