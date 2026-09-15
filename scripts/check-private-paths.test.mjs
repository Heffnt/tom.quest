import { describe, expect, it } from "vitest";
import {
  BOX_WIKITOM_DIR,
  LAPTOP_WIKITOM_DIR,
  categoryContentFindings,
  OPERATE_LINE_MIN,
  operateContentFindings,
  operateLines,
  checkPrivatePaths,
  privatePathFindings,
  wikiTomCategoryLines,
  wikiTomRoot,
} from "./check-private-paths.mjs";

describe("private path guardrail", () => {
  it("allows the two public know triggers and ordinary eval files", () => {
    expect(privatePathFindings([
      "evals/triggers/skill-know-intent.json",
      "evals/triggers/skill-know-week.json",
      "evals/triggers/layer-know.json",
      "evals/golden/runs/example.json",
    ])).toEqual([]);
  });

  it("rejects every know-area trigger spelling and the forbidden private paths", () => {
    expect(privatePathFindings([
      "evals\\triggers\\skill-know-research.json",
      "model-of-tom/areas/money.md",
      "evals/snapshots/areas/social.json",
      "evals/private/raw.json",
    ])).toEqual([
      { file: "evals/private/raw.json", rule: "private eval fixture directory" },
      { file: "evals/snapshots/areas/social.json", rule: "area-page copy under evals" },
      { file: "evals/triggers/skill-know-research.json", rule: "private know-area trigger" },
      { file: "model-of-tom/areas/money.md", rule: "model-of-tom area page" },
    ]);
  });

  it("checks only the tracked paths supplied by git", () => {
    const run = (_file, args, options) => {
      expect(args).toEqual(["ls-files", "-z"]);
      expect(options.encoding).toBe("utf8");
      return "evals/triggers/skill-know-health-and-food.json\0README.md\0";
    };
    expect(checkPrivatePaths(run, { root: null })).toEqual([
      { file: "evals/triggers/skill-know-health-and-food.json", rule: "private know-area trigger" },
    ]);
  });

  // Every fixture here is synthetic: the check is exercised without writing a
  // single real term into this repository, which is the point of the check.
  const CATEGORY_LINES = ["categories: [alpha, beta-gamma, delta]", "categories: [epsilon, zeta, eta]"];

  const findingsFor = (bodies) => categoryContentFindings(Object.keys(bodies), CATEGORY_LINES, {
    readFile: (file) => {
      const body = bodies[file.replaceAll("\\", "/").slice("C:/public/".length)];
      if (body === undefined) throw new Error("ENOENT");
      return body;
    },
    cwd: "C:/public",
  });

  it("rejects a copied line and every list spelling of three of its terms", () => {
    expect(findingsFor({
      "exact.md": "categories: [alpha, beta-gamma, delta]",
      "array.mjs": 'const terms = ["alpha", "beta-gamma", "delta"];',
      "multiline.json": '{\n  "categories": [\n    "alpha",\n    "beta-gamma",\n    "delta"\n  ]\n}',
      "table.md": "| alpha | beta-gamma | delta |",
      "rows.md": "- alpha\n- beta-gamma\n- delta\n",
    }).map(({ file }) => file)).toEqual(["array.mjs", "exact.md", "multiline.json", "rows.md", "table.md"]);
  });

  it("leaves prose, short runs and terms from two different pages alone", () => {
    expect(findingsFor({
      // Three terms of one page, but written as a sentence rather than a list:
      // the agent-systems page names this repository's own vocabulary, so the
      // looser rule would fail the repository's prose about itself.
      "prose.md": "The alpha run reached beta-gamma before delta did.",
      "phrase.md": "Alpha Beta-Gamma Delta",
      "two.md": "categories: [alpha, beta-gamma]",
      "mixed.md": "const terms = [\"alpha\", \"beta-gamma\", \"zeta\", \"eta\"];",
    })).toEqual([]);
  });

  it("skips binary files and tracked paths it cannot read", () => {
    expect(findingsFor({ "logo.png": "categories: [alpha, beta-gamma, delta]" })).toEqual([]);
    expect(categoryContentFindings(["gone.md"], CATEGORY_LINES, {
      readFile: () => { throw new Error("ENOENT"); },
      cwd: "C:/public",
    })).toEqual([]);
  });

  it("reads only category frontmatter from every area page", () => {
    const entries = [
      { name: "zeta.md", isFile: () => true },
      { name: "alpha.md", isFile: () => true },
      { name: "note.txt", isFile: () => true },
    ];
    const readFile = (file) => (file.endsWith("alpha.md") ? "---\ncategories: [amber, birch]\n---\nbody" : "---\ncategories: [cobalt, dahlia]\n---\nbody");
    expect(wikiTomCategoryLines("C:/private", { exists: () => true, readdir: () => entries, readFile })).toEqual([
      "categories: [amber, birch]",
      "categories: [cobalt, dahlia]",
    ]);
  });

  it("resolves the checkout the search tool resolves, and nothing when it is absent", () => {
    expect(wikiTomRoot({ env: { WIKITOM_DIR: "D:/vault" }, platform: "linux", exists: () => true })).toBe("D:/vault");
    expect(wikiTomRoot({ env: {}, platform: "win32", exists: () => true })).toBe(LAPTOP_WIKITOM_DIR);
    expect(wikiTomRoot({ env: {}, platform: "linux", exists: () => true })).toBe(BOX_WIKITOM_DIR);
    expect(wikiTomRoot({ env: {}, platform: "linux", exists: () => false })).toBeNull();
  });

  // THE OPERATE RULE. Its lines are invented here for the same reason the
  // category ones are: a test for a copy must not be the copy. A real line is
  // matched as a SUBSTRING, because the ways it leaks are inside a string
  // literal, a template or a comment — which is how three of them survived a
  // sweep that compared whole lines.
  const OPERATE = [
    "- a sentence of the operate page long enough to be nobody else" + String.fromCharCode(39) + "s.",
    "- a second such sentence, also past the forty-character floor.",
  ];

  const operateFor = (bodies) => operateContentFindings(Object.keys(bodies), OPERATE, {
    readFile: (file) => {
      const body = bodies[file.replaceAll(String.fromCharCode(92), "/").slice("C:/public/".length)];
      if (body === undefined) throw new Error("ENOENT");
      return body;
    },
    cwd: "C:/public",
  });

  it("rejects an operate line however it is embedded, and leaves other prose alone", () => {
    expect(operateFor({
      "whole.md": OPERATE[0],
      "in-a-string.mjs": `const fixture = "${OPERATE[1]}";`,
      "in-a-comment.mjs": `// ${OPERATE[0]}`,
      "indented.md": `  ${OPERATE[1]}  `,
      "innocent.mjs": "- a line this repository wrote for itself, of a similar length.",
      "shape-only.md": "### Repos",
    }).map(({ file }) => file)).toEqual(["in-a-comment.mjs", "in-a-string.mjs", "indented.md", "whole.md"]);
  });

  it("reads only the operate lines past the floor, and nothing when the page is absent", () => {
    const page = [
      "# Agent rules",
      "### Repos",
      "- short one.",
      "- a sentence of the operate page long enough to be nobody else" + String.fromCharCode(39) + "s.",
    ].join("\n");
    const lines = operateLines("C:/vault", { exists: () => true, readFile: () => page });
    expect(lines).toEqual([OPERATE[0]]);
    for (const line of lines) expect(line.length).toBeGreaterThanOrEqual(OPERATE_LINE_MIN);
    expect(operateLines("C:/vault", { exists: () => false, readFile: () => page })).toBeNull();
  });

  it("keeps path checks active and emits a deterministic notice without a checkout", () => {
    const notes = [];
    const run = () => "evals/triggers/skill-know-research.json\0";
    expect(checkPrivatePaths(run, { root: null, notice: (line) => notes.push(line) })).toEqual([
      { file: "evals/triggers/skill-know-research.json", rule: "private know-area trigger" },
    ]);
    // BOTH CONTENT CHECKS SAY SO SEPARATELY. A check with nothing to compare
    // must name itself, or a reader counting green checks counts one that
    // never ran.
    expect(notes).toEqual([
      "private-paths: WikiTom checkout unavailable; area-category content check skipped\n",
      "private-paths: WikiTom checkout unavailable; operate content check skipped\n",
    ]);

    // A checkout whose area directory holds no page is the same absence.
    const empty = [];
    checkPrivatePaths(run, {
      root: "C:/private",
      fs: { exists: () => true, readdir: () => [], readFile: () => "" },
      notice: (line) => empty.push(line),
    });
    expect(empty).toEqual([
      "private-paths: WikiTom checkout unavailable; area-category content check skipped\n",
      "private-paths: WikiTom checkout unavailable; operate content check skipped\n",
    ]);
  });
});
