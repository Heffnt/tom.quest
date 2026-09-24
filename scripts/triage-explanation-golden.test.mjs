import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { triage, triageItem } from "./triage-explanation-golden.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-golden-"));
  dirs.push(dir);
  return dir;
}

const item = (over = {}) => ({
  id: "explanation-n1",
  source: "explanation",
  job: "explanation",
  partition: "explanation/ComplexMultiTrigger",
  label: "did not",
  sentence: "too dense",
  confirmedByTom: false,
  ruledOn: "2026-08-17",
  input: { topic: "Z-Defence deviations", contextLines: [] },
  output: { explanation: "the old one" },
  ...over,
});

describe("triageItem", () => {
  it("puts the mark straight after confirmedByTom, where a reader meets it before the input", () => {
    const { item: marked, changed } = triageItem(item(), "/nowhere", {
      replay: () => ({ unreplayable: "no transcript" }),
    });
    expect(changed).toBe(true);
    expect(Object.keys(marked)).toEqual([
      "id", "source", "job", "partition", "label", "sentence", "confirmedByTom",
      "unreplayable", "ruledOn", "input", "output",
    ]);
    expect(marked.unreplayable).toBe("no transcript");
  });

  it("REMOVES the key on an item the archive can now replay, rather than setting it false", () => {
    const { item: repaired, changed } = triageItem(item({ unreplayable: "no transcript" }), "/nowhere", {
      replay: () => ({ lines: ["Tom:", "ask", ""] }),
    });
    expect(changed).toBe(true);
    expect(Object.hasOwn(repaired, "unreplayable")).toBe(false);
  });

  it("changes nothing when the answer is the one already in the file", () => {
    const already = item({ unreplayable: "no transcript" });
    const { item: same, changed } = triageItem(already, "/nowhere", {
      replay: () => ({ unreplayable: "no transcript" }),
    });
    expect(changed).toBe(false);
    expect(same).toBe(already);
  });

  it("still marks an item with no confirmedByTom to anchor to", () => {
    const { item: marked } = triageItem({ id: "x", job: "explanation" }, "/nowhere", {
      replay: () => ({ unreplayable: "no transcript" }),
    });
    expect(marked.unreplayable).toBe("no transcript");
  });
});

describe("triage", () => {
  it("writes the mark into each file and reports what it found", () => {
    const dir = tree();
    fs.writeFileSync(path.join(dir, "explanation-n1.json"), `${JSON.stringify(item(), null, 2)}\n`);
    fs.writeFileSync(path.join(dir, "explanation-p1.json"), `${JSON.stringify(item({ id: "explanation-p1", label: "landed" }), null, 2)}\n`);
    // A README beside the items is not an item.
    fs.writeFileSync(path.join(dir, "README.md"), "# explanations\n");
    const rows = triage(dir, "/nowhere", {
      replay: (_tree, one) => (one.id === "explanation-n1" ? { unreplayable: "no transcript" } : { lines: [] }),
    });
    expect(rows).toEqual([
      { id: "explanation-n1", changed: true, unreplayable: "no transcript" },
      { id: "explanation-p1", changed: false, unreplayable: null },
    ]);
    const written = JSON.parse(fs.readFileSync(path.join(dir, "explanation-n1.json"), "utf8"));
    expect(written.unreplayable).toBe("no transcript");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "explanation-p1.json"), "utf8")).unreplayable).toBeUndefined();
  });

  it("writes nothing on a dry run", () => {
    const dir = tree();
    const file = path.join(dir, "explanation-n1.json");
    const before = `${JSON.stringify(item(), null, 2)}\n`;
    fs.writeFileSync(file, before);
    triage(dir, "/nowhere", { write: false, replay: () => ({ unreplayable: "no transcript" }) });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
