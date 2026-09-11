import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUT,
  SOURCES,
  draftFor,
  fileStem,
  headingsOf,
  isPositive,
  parseArgs,
  scaffold,
} from "./scaffold-negatives.mjs";

const TRIGGERS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", DEFAULT_OUT);

/** A layer text shaped like the assembler's: a title, then `## ` rule
 *  headings. Only the headings are read, so nothing else has to be faithful. */
function layerText(name) {
  return `── model-of-tom/${name}.md ──\n# ${name}\n\n## Registers\n- one\n\n## Form\n- two\n`;
}

/** Every side effect the script has, recorded rather than performed: one child
 *  process for the assembler and one write per draft. */
function fakeIo(existingByStem = {}) {
  const written = new Map();
  return {
    written,
    layers: (wikitom, names) => ({
      commit: "0123456789abcdef",
      layers: Object.fromEntries(names.map((name) => [name, layerText(name)])),
    }),
    existing: (out, stem) => existingByStem[stem] ?? null,
    write: (file, text) => written.set(file, text),
  };
}

/** A trigger file with `count` positives, in the shape the runner loads. */
function withPositives(name, count) {
  return {
    name,
    kind: "layer",
    note: null,
    cases: Array.from({ length: count }, (_, index) => ({
      id: `layer-${name}-pos-${index + 1}`,
      negative: false,
      prompt: `prompt ${index + 1}`,
      why: "the rule applies here",
      expect: { mustNotName: ["never this"] },
      confirmedByTom: true,
    })),
  };
}

describe("scaffold", () => {
  it("produces one draft per source, named for it and ending .draft.json", () => {
    const io = fakeIo();
    const result = scaffold({ out: "evals/triggers" }, io);
    expect(result.drafts).toHaveLength(SOURCES.length);
    expect(result.drafts.map((one) => one.source.name)).toEqual(SOURCES.map((source) => source.name));
    for (const one of result.drafts) {
      expect(path.basename(one.file)).toBe(`${fileStem(one.source)}.draft.json`);
      expect(one.file.endsWith(".draft.json")).toBe(true);
    }
    expect(result.written).toEqual(result.drafts.map((one) => one.file));
    expect([...io.written.keys()]).toEqual(result.written);
  });

  it("drafts one negative per existing positive, and none where there are none", () => {
    const io = fakeIo({ "layer-write": withPositives("write", 3), "layer-know": withPositives("know", 1) });
    const result = scaffold({ out: "evals/triggers" }, io);
    const byName = Object.fromEntries(result.drafts.map((one) => [one.source.name, one.draft]));
    expect(byName.write.cases).toHaveLength(3);
    expect(byName.know.cases).toHaveLength(1);
    // operate has no file in this fixture, so nothing is owed and the draft is
    // still written — "nothing owed" is an answer, an absent file is not.
    expect(byName.operate.cases).toHaveLength(0);
    expect(io.written.has(path.join("evals/triggers", "layer-operate.draft.json"))).toBe(true);
  });

  it("marks every drafted case as an unconfirmed negative carrying a why", () => {
    const io = fakeIo({ "layer-write": withPositives("write", 2), "layer-know": withPositives("know", 2) });
    const cases = scaffold({ out: "evals/triggers" }, io).drafts.flatMap((one) => one.draft.cases);
    expect(cases.length).toBeGreaterThan(0);
    for (const one of cases) {
      expect(one.negative).toBe(true);
      expect(typeof one.why).toBe("string");
      expect(one.why.trim()).not.toBe("");
      expect(one.confirmedByTom).toBe(false);
      // Empty on purpose: a model-invented negative that is wrong teaches the
      // set to accept a real failure, so the scaffold owes the pairing and
      // never the prompt.
      expect(one.prompt).toBe("");
      expect(one.expect.mustNotName).toEqual([]);
    }
    // Paired to the positive that is still unbalanced, by id.
    expect(cases.map((one) => one.id)).toContain("layer-write-pos-1-neg");
  });

  it("carries the layer's rule headings into the draft, read from the assembler", () => {
    const io = fakeIo();
    const byName = Object.fromEntries(scaffold({}, io).drafts.map((one) => [one.source.name, one.draft]));
    expect(byName.write.headings).toEqual(["Registers", "Form"]);
    expect(headingsOf(layerText("write"))).toEqual(["Registers", "Form"]);
  });

  it("writes nothing under --dry-run or --list, and still reports what it would write", () => {
    for (const options of [{ dryRun: true }, { list: true }]) {
      const io = fakeIo({ "layer-write": withPositives("write", 2) });
      const result = scaffold(options, io);
      expect(result.written).toEqual([]);
      expect(io.written.size).toBe(0);
      expect(result.drafts).toHaveLength(SOURCES.length);
      expect(result.drafts.find((one) => one.source.name === "write").draft.cases).toHaveLength(2);
    }
  });
});

describe("parseArgs", () => {
  it("takes both spellings of a valued flag and both switches", () => {
    expect(parseArgs(["--wikitom", "/root/wikitom", "--out=evals/triggers", "--dry-run", "--list"])).toEqual({
      wikitom: "/root/wikitom",
      out: "evals/triggers",
      dryRun: true,
      list: true,
    });
  });

  it("refuses an unknown argument and a valued flag with no value", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--out"])).toThrow(/needs a value/);
  });
});

/**
 * THE RULE'S HOME until the runner's own test lands: the committed set itself
 * is read and checked. A trigger file that does not parse, that repeats an id,
 * that invents a third expectation key, or that asserts more firings than
 * silences is a file that cannot do the job the directory exists for.
 */
describe("evals/triggers", () => {
  const names = fs.readdirSync(TRIGGERS).filter((name) => name.endsWith(".json") && !name.endsWith(".draft.json"));

  it("has a file for every layer source", () => {
    expect(names.sort()).toEqual(SOURCES.map((source) => `${fileStem(source)}.json`).sort());
  });

  it.each(names)("%s parses, and its cases are unique and well shaped", (name) => {
    const file = JSON.parse(fs.readFileSync(path.join(TRIGGERS, name), "utf8"));
    expect(typeof file.name).toBe("string");
    expect(["layer", "skill"]).toContain(file.kind);
    expect(`${file.kind}-${file.name}.json`).toBe(name);
    expect(Array.isArray(file.cases)).toBe(true);
    const ids = file.cases.map((one) => one.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const one of file.cases) {
      expect(typeof one.id).toBe("string");
      expect(typeof one.negative).toBe("boolean");
      expect(typeof one.prompt).toBe("string");
      expect(one.prompt.trim()).not.toBe("");
      expect(typeof one.why).toBe("string");
      expect(one.why.trim()).not.toBe("");
      expect(typeof one.confirmedByTom).toBe("boolean");
      // The ONE vocabulary: exactly what mechanicalChecks in worker/jobs/
      // evals.mjs reads. A third key would be a check nothing runs.
      expect(Object.keys(one.expect).every((key) => key === "mustName" || key === "mustNotName")).toBe(true);
      expect(Object.keys(one.expect).length).toBeGreaterThan(0);
      for (const needle of [...(one.expect.mustName ?? []), ...(one.expect.mustNotName ?? [])]) {
        expect(typeof needle).toBe("string");
        expect(needle.trim()).not.toBe("");
      }
    }
  });

  it.each(names)("%s carries at least as many negatives as positives", (name) => {
    const file = JSON.parse(fs.readFileSync(path.join(TRIGGERS, name), "utf8"));
    const negatives = file.cases.filter((one) => one.negative === true).length;
    const positives = file.cases.filter(isPositive).length;
    expect(negatives).toBeGreaterThanOrEqual(positives);
    // A file with no negatives is only right when it says why it has none.
    if (negatives === 0) expect(typeof file.note).toBe("string");
  });

  it("checks a negative mechanically, with no judge", () => {
    for (const name of names) {
      const file = JSON.parse(fs.readFileSync(path.join(TRIGGERS, name), "utf8"));
      for (const one of file.cases.filter((two) => two.negative === true)) {
        expect(one.expect.mustNotName?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
