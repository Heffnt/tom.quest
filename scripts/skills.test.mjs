import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AREAS_DIR,
  DESCRIPTION_MAX_BYTES,
  areaCategories,
  buildSkills,
  byteLength,
  describe as describeSkill,
  parseRepoBullets,
  renderGrants,
  renderSkillMd,
  skillDirName,
} from "./skills.mjs";

// ── Fixture ──────────────────────────────────────────────────────────────────
// A whole WikiTom in strings. buildSkills does no I/O, so a fixture is text and
// nothing else — which is the point of keeping skills.mjs pure.

const AGENT_RULES = [
  "# Agent rules",
  "",
  "## Map",
  "",
  "### Repos",
  "- tom.quest: site, Convex record, box jobs; AGENTS.md in app/, convex/.",
  "- WikiTom: the vault. model-of-tom/, sources/, tom-text/.",
  "- ComplexMultiTrigger (CMT): his research code; AGENTS.md in cmt/engine.",
  "",
  "### TTS",
  "- todos, batches, rulings.",
  "",
].join("\n");

const AREA_CATEGORIES = Object.freeze({
  admin: "[admin, email, chores]",
  "agent-systems": "[agent-systems, tts, code]",
  climbing: "[climbing, team, practice]",
  "health-and-food": "[health, food, cooking]",
  "mental-health": "[mental-health, therapy, sleep]",
  money: "[money, budget, billing]",
  research: "[research, paper, cmt]",
  social: "[social, dnd, family]",
});

function areaPage(name, categories, extraFields = "") {
  return {
    path: `${AREAS_DIR}/${name}.md`,
    body: `---\nupdated: 2026-09-10\ncategories: ${categories}\n${extraFields}---\n\n## Current state\n\n- ${name} holds.\n`,
  };
}

function fixturePages(extra = []) {
  return [
    { path: "model-of-tom/agent-rules.md", body: AGENT_RULES },
    { path: "model-of-tom/writing.md", body: "# Writing\n\n## Registers\n\nPlain.\n\n## Form\n\nShort.\n" },
    { path: "model-of-tom/ground.md", body: "# Ground\n\nWhat he already knows.\n" },
    { path: "model-of-tom/intent.md", body: "# Intent\n\n## Directions\n\nGo.\n\n## What to protect\n\nSleep.\n" },
    { path: "model-of-tom/priorities.md", body: "# Priorities\n\nResearch first.\n" },
    { path: "model-of-tom/schedule.md", body: "# Schedule\n\nTuesday is practice.\n" },
    ...Object.entries(AREA_CATEGORIES).map(([name, categories]) => areaPage(name, categories)),
    ...extra,
  ];
}

const FIXTURE_REPOS = Object.freeze([
  {
    repo: "tom.quest",
    commit: "a".repeat(40),
    files: [
      { path: "AGENTS.md", body: "# tom.quest\n\nRoot rules.\n" },
      { path: "convex/AGENTS.md", body: "# convex\n\nNested rules.\n" },
    ],
  },
  { repo: "WikiTom", commit: "b".repeat(40), files: [{ path: "AGENTS.md", body: "# WikiTom\n\nVault rules.\n" }] },
  {
    repo: "ComplexMultiTrigger",
    commit: "c".repeat(40),
    files: [{ path: "AGENTS.md", body: "# CMT\n\nResearch code.\n" }],
  },
]);

const COMMIT = "0".repeat(40);

function build(overrides = {}) {
  return buildSkills({
    commit: COMMIT,
    pages: fixturePages(),
    repos: FIXTURE_REPOS,
    agentRules: AGENT_RULES,
    ...overrides,
  });
}

const EXPECTED = Object.freeze([
  ["write", "write"],
  ["know-intent", "know"],
  ["know-week", "know"],
  ["know-admin", "know"],
  ["know-agent-systems", "know"],
  ["know-climbing", "know"],
  ["know-health-and-food", "know"],
  ["know-mental-health", "know"],
  ["know-money", "know"],
  ["know-research", "know"],
  ["know-social", "know"],
  ["repo-tom.quest", "repo"],
  ["repo-WikiTom", "repo"],
  ["repo-ComplexMultiTrigger", "repo"],
]);

// ── The real vault ───────────────────────────────────────────────────────────
// Tom's own model-of-tom, when this machine has it. CI has no vault, so every
// test that reads it skips rather than fails: the fixture above is what pins
// the shapes, and these pin that HIS text fits the cap the shapes promise.

const WIKITOM_DIR = process.env.WIKITOM_DIR ?? "C:/Users/heffn/Desktop/WikiTom-uae";
const HAS_VAULT = fs.existsSync(path.join(WIKITOM_DIR, "model-of-tom", "agent-rules.md"));

function vaultPages() {
  const root = path.join(WIKITOM_DIR, "model-of-tom");
  const fixed = ["agent-rules.md", "writing.md", "ground.md", "intent.md", "priorities.md", "schedule.md"]
    .filter((name) => fs.existsSync(path.join(root, name)))
    .map((name) => ({ path: `model-of-tom/${name}`, body: fs.readFileSync(path.join(root, name), "utf8") }));
  const areas = fs
    .readdirSync(path.join(root, "areas"))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ path: `${AREAS_DIR}/${name}`, body: fs.readFileSync(path.join(root, "areas", name), "utf8") }));
  return [...fixed, ...areas];
}

describe("skills: the set", () => {
  it("expands to exactly the 14 skills, in order, with their groups", () => {
    const { skills, refused } = build();
    expect(refused).toEqual([]);
    expect(skills.map((skill) => [skill.name, skill.group])).toEqual(EXPECTED.map((row) => [...row]));
  });

  it("gains exactly one skill when Tom adds one area page, and changes nothing else", () => {
    const before = build();
    const after = build({ pages: fixturePages([areaPage("zebra", "[zebra, stripes]")]) });
    expect(after.skills).toHaveLength(before.skills.length + 1);
    expect(after.skills.map((skill) => skill.name).filter((name) => !before.skills.some((s) => s.name === name))).toEqual(
      ["know-zebra"],
    );
    for (const skill of before.skills) {
      const now = after.skills.find((candidate) => candidate.name === skill.name);
      expect(now.description).toBe(skill.description);
      expect(now.body).toBe(skill.body);
    }
  });

  it("carries the write skill's ground.md as a reference and the repo's nested rules flattened", () => {
    const { skills } = build();
    const write = skills.find((skill) => skill.name === "write");
    expect(write.references.map((reference) => [reference.name, reference.path])).toEqual([
      ["ground.md", "model-of-tom/ground.md"],
    ]);
    const repo = skills.find((skill) => skill.name === "repo-tom.quest");
    expect(repo.references.map((reference) => reference.name)).toEqual(["convex-AGENTS.md"]);
  });

  it("joins know-intent's two pages the way the layer assembler joins files", () => {
    const { skills } = build();
    const intent = skills.find((skill) => skill.name === "know-intent");
    expect(intent.sourcePaths).toEqual(["model-of-tom/intent.md", "model-of-tom/priorities.md"]);
    expect(intent.body.split("\n")[0]).toBe("\u2500\u2500 model-of-tom/intent.md \u2500\u2500");
    expect(intent.body).toContain("\n\n\u2500\u2500 model-of-tom/priorities.md \u2500\u2500\n");
  });

  it("strips an area page's frontmatter out of its body", () => {
    const { skills } = build();
    const admin = skills.find((skill) => skill.name === "know-admin");
    expect(admin.body).toBe("## Current state\n\n- admin holds.");
    expect(admin.body).not.toContain("categories:");
  });

  it("resolves a repo named by the map's alias", () => {
    const { skills, refused } = build({ repos: [{ repo: "CMT", files: [{ path: "AGENTS.md", body: "x" }] }] });
    expect(refused).toEqual([]);
    expect(skills.map((skill) => skill.name)).toContain("repo-CMT");
  });
});

describe("skills: refusals", () => {
  it("refuses a missing source rather than throwing, and still builds the rest", () => {
    const pages = fixturePages().filter((page) => page.path !== "model-of-tom/writing.md");
    const { skills, refused } = build({ pages });
    expect(skills.map((skill) => skill.name)).not.toContain("write");
    expect(skills).toHaveLength(EXPECTED.length - 1);
    expect(refused).toEqual([{ name: "write", why: "model-of-tom/writing.md is absent at this commit" }]);
  });

  it("refuses a blank source the same way", () => {
    const pages = fixturePages().map((page) =>
      page.path === "model-of-tom/schedule.md" ? { ...page, body: " \n\t\n" } : page,
    );
    const { skills, refused } = build({ pages });
    expect(skills.map((skill) => skill.name)).not.toContain("know-week");
    expect(refused).toEqual([{ name: "know-week", why: "model-of-tom/schedule.md is blank at this commit" }]);
  });

  it("refuses a repo whole when it has no root AGENTS.md", () => {
    const repos = [{ repo: "WikiTom", files: [{ path: "tts/AGENTS.md", body: "nested only" }] }];
    const { skills, refused } = build({ repos });
    expect(skills.map((skill) => skill.name)).not.toContain("repo-WikiTom");
    expect(refused).toEqual([{ name: "repo-WikiTom", why: "no published body at this commit" }]);
  });

  it("refuses a repo the map does not name", () => {
    const repos = [{ repo: "Byobu", files: [{ path: "AGENTS.md", body: "x" }] }];
    const { refused } = build({ repos });
    expect(refused).toEqual([{ name: "repo-Byobu", why: "the map's `### Repos` block does not name it" }]);
  });
});

describe("skills: descriptions", () => {
  it("keeps every fixture description inside the 200-byte cap", () => {
    for (const skill of build().skills) {
      expect(byteLength(skill.description), `${skill.name}: ${skill.description}`).toBeLessThanOrEqual(
        DESCRIPTION_MAX_BYTES,
      );
    }
  });

  it.runIf(HAS_VAULT)("keeps every description of the REAL model-of-tom inside the cap", () => {
    const pages = vaultPages();
    const agentRules = pages.find((page) => page.path === "model-of-tom/agent-rules.md").body;
    const repos = parseRepoBullets(agentRules).flatMap((bullet) =>
      bullet.names.map((name) => ({ repo: name, files: [{ path: "AGENTS.md", body: "# rules\n" }] })),
    );
    const { skills, refused } = buildSkills({ commit: COMMIT, pages, repos, agentRules });
    expect(refused).toEqual([]);
    expect(skills.length).toBeGreaterThanOrEqual(14);
    for (const skill of skills) {
      expect(byteLength(skill.description), `${skill.name}: ${skill.description}`).toBeLessThanOrEqual(
        DESCRIPTION_MAX_BYTES,
      );
    }
  });

  it("is byte-identical for a fixed input", () => {
    const first = build().skills.map((skill) => skill.description);
    const second = build().skills.map((skill) => skill.description);
    expect(second).toEqual(first);
  });

  it("truncates a long tail at a word boundary with a trailing ellipsis", () => {
    const long = Array.from({ length: 40 }, (_, index) => `category${index}`).join(", ");
    const pages = fixturePages().map((page) =>
      page.path === `${AREAS_DIR}/research.md` ? areaPage("research", `[${long}]`) : page,
    );
    const research = build({ pages }).skills.find((skill) => skill.name === "know-research");
    expect(byteLength(research.description)).toBeLessThanOrEqual(DESCRIPTION_MAX_BYTES);
    expect(research.description).toContain("…");
    expect(research.description).toMatch(/…\sLoad before planning, judging or deciding anything in this area\.$/);
    expect(research.description).not.toMatch(/,…/);
  });

  it("lets a page's `skill:` frontmatter replace the generated description verbatim", () => {
    const chosen = "Tom's climbing team and his exec role. Load before anything about practice or the gym.";
    const pages = fixturePages().map((page) =>
      page.path === `${AREAS_DIR}/climbing.md` ? areaPage("climbing", "[climbing, team]", `skill: ${chosen}\n`) : page,
    );
    const climbing = build({ pages }).skills.find((skill) => skill.name === "know-climbing");
    expect(climbing.description).toBe(chosen);
  });

  it("throws, naming the page, when a `skill:` override is over the cap", () => {
    const over = "x".repeat(DESCRIPTION_MAX_BYTES + 1);
    const pages = fixturePages().map((page) =>
      page.path === `${AREAS_DIR}/money.md` ? areaPage("money", "[money]", `skill: ${over}\n`) : page,
    );
    expect(() => build({ pages })).toThrow(/model-of-tom\/areas\/money\.md/);
    expect(() => build({ pages })).toThrow(/over the 200-byte cap/);
  });

  it("throws when a shape's own base text is over the cap", () => {
    expect(() =>
      describeSkill({ shape: "area", name: "know-x", variable: "y".repeat(DESCRIPTION_MAX_BYTES), tail: "z" }),
    ).toThrow(/base is \d+ bytes, over the 200-byte cap/);
  });
});

describe("skills: area categories", () => {
  it("strips the frontmatter brackets", () => {
    const page = areaPage("admin", "[admin, email]");
    expect(areaCategories(page.path, page.body)).toEqual(["admin", "email"]);
    expect(areaCategories(page.path, page.body)).not.toContain("[admin");
    expect(areaCategories(page.path, page.body)).not.toContain("email]");
  });

  it("puts the page's own name first, lowercased and de-duplicated", () => {
    const page = areaPage("health-and-food", "[Food, food, HEALTH]");
    expect(areaCategories(page.path, page.body)).toEqual(["health-and-food", "food", "health"]);
  });

  it("gives a page with no categories line its own name alone", () => {
    expect(areaCategories(`${AREAS_DIR}/social.md`, "## Current state\n\n- No frontmatter.\n")).toEqual(["social"]);
  });

  it("keeps no category term in two area skills", () => {
    const lists = fixturePages()
      .filter((page) => page.path.startsWith(`${AREAS_DIR}/`))
      .map((page) => ({ path: page.path, terms: areaCategories(page.path, page.body) }));
    const owner = new Map();
    for (const { path: where, terms } of lists) {
      for (const term of terms) {
        expect(owner.has(term), `${term} is in both ${owner.get(term)} and ${where}`).toBe(false);
        owner.set(term, where);
      }
    }
  });

  it.runIf(HAS_VAULT)("keeps no category term in two of the REAL area pages", () => {
    const owner = new Map();
    for (const page of vaultPages().filter((candidate) => candidate.path.startsWith(`${AREAS_DIR}/`))) {
      for (const term of areaCategories(page.path, page.body)) {
        expect(owner.has(term), `${term} is in both ${owner.get(term)} and ${page.path}`).toBe(false);
        owner.set(term, page.path);
      }
    }
  });
});

describe("skills: the map's Repos block", () => {
  it("parses names, aliases and the line itself", () => {
    const bullets = parseRepoBullets(AGENT_RULES);
    expect(bullets.map((bullet) => bullet.names)).toEqual([["tom.quest"], ["WikiTom"], ["ComplexMultiTrigger"]]);
    expect(bullets[2].aliases).toEqual({ ComplexMultiTrigger: "CMT" });
    expect(bullets[0].line).toBe("tom.quest: site, Convex record, box jobs; AGENTS.md in app/, convex/.");
  });

  it("stops at the next heading", () => {
    expect(parseRepoBullets(AGENT_RULES).some((bullet) => bullet.line.startsWith("todos"))).toBe(false);
  });

  it("takes four names off one bullet", () => {
    const bullets = parseRepoBullets(
      "### Repos\n- Overleaf (the paper), Byobu, THMM, BioEng: AGENTS.md where it exists.\n",
    );
    expect(bullets[0].names).toEqual(["Overleaf", "Byobu", "THMM", "BioEng"]);
    expect(bullets[0].aliases).toEqual({ Overleaf: "the paper" });
  });

  it("throws with the bullet quoted when it has no colon", () => {
    expect(() => parseRepoBullets("### Repos\n- tom.quest is the site\n")).toThrow(
      '`### Repos` bullet has no colon: "tom.quest is the site"',
    );
  });

  it("throws when there is no Repos block at all", () => {
    expect(() => parseRepoBullets("# Agent rules\n\n## Map\n")).toThrow(/has no `### Repos` block/);
  });

  it.runIf(HAS_VAULT)("parses the REAL map: eight repositories and the CMT alias", () => {
    const bullets = parseRepoBullets(
      fs.readFileSync(path.join(WIKITOM_DIR, "model-of-tom", "agent-rules.md"), "utf8"),
    );
    const names = bullets.flatMap((bullet) => bullet.names);
    expect(names).toEqual(
      expect.arrayContaining([
        "tom.quest",
        "WikiTom",
        "ComplexMultiTrigger",
        "Overleaf",
        "Byobu",
        "THMM",
        "BioEng",
        "Heffnt/literature",
      ]),
    );
    expect(bullets.find((bullet) => bullet.names.includes("ComplexMultiTrigger")).aliases.ComplexMultiTrigger).toBe(
      "CMT",
    );
  });
});

describe("skills: rendering", () => {
  it("writes a frontmatter of name and description and nothing else", () => {
    const skill = build().skills.find((candidate) => candidate.name === "know-research");
    const text = renderSkillMd(skill, COMMIT);
    const block = text.split("\n---\n")[0].split("\n").slice(1);
    expect(block).toEqual([`name: ${skillDirName("know-research")}`, `description: ${JSON.stringify(skill.description)}`]);
    expect(text).toContain(
      `<!-- generated from WikiTom model-of-tom/areas/research.md at commit ${COMMIT} — do not edit -->`,
    );
    expect(text.endsWith("\n")).toBe(true);
  });

  it("names every source path of a two-page skill", () => {
    const intent = build().skills.find((candidate) => candidate.name === "know-intent");
    expect(renderSkillMd(intent, COMMIT)).toContain(
      "generated from WikiTom model-of-tom/intent.md, model-of-tom/priorities.md at commit",
    );
  });

  it("names the repository's own commit on a repo skill", () => {
    const repo = build().skills.find((candidate) => candidate.name === "repo-tom.quest");
    expect(renderSkillMd(repo, COMMIT)).toContain(`generated from tom.quest AGENTS.md at commit ${"a".repeat(40)}`);
  });

  it("quotes a description that carries a quote or a colon", () => {
    const skill = {
      name: "know-x",
      description: 'Tom\'s "x": a colon and a quote.',
      body: "body",
      sourcePaths: ["model-of-tom/areas/x.md"],
      references: [],
      origin: "WikiTom",
    };
    expect(renderSkillMd(skill, COMMIT)).toContain('description: "Tom\'s \\"x\\": a colon and a quote."');
  });
});

describe("skills: the grant block", () => {
  it("renders granted and refused", () => {
    expect(
      renderGrants({
        commit: COMMIT,
        granted: ["write", "know-research"],
        refused: [{ name: "repo-ComplexMultiTrigger", why: "no published body at this commit" }],
      }),
    ).toBe(
      [
        `SKILLS (WikiTom commit ${COMMIT})`,
        "granted: write, know-research",
        "refused: repo-ComplexMultiTrigger — no published body at this commit",
        "Load each granted skill before you act on what it covers. `tts search skills` lists the rest.",
      ].join("\n"),
    );
  });

  it("omits the refused line entirely when nothing was refused", () => {
    const text = renderGrants({ commit: COMMIT, granted: ["write"] });
    expect(text).not.toContain("refused");
    expect(text.split("\n")).toHaveLength(3);
    expect(text.endsWith("\n")).toBe(false);
  });

  it("says granted: — when nothing is granted", () => {
    expect(renderGrants({ commit: COMMIT, granted: [], refused: [] }).split("\n")[1]).toBe("granted: —");
  });

  it("strips the tom- prefix off every name", () => {
    const text = renderGrants({
      commit: COMMIT,
      granted: ["tom-write", "know-week"],
      refused: [{ name: "tom-repo-WikiTom", why: "no published body at this commit" }],
    });
    expect(text).not.toContain("tom-");
    expect(text.split("\n")[1]).toBe("granted: write, know-week");
  });

  it("is byte-identical for the same input", () => {
    const input = { commit: COMMIT, granted: ["write"], refused: [{ name: "repo-Byobu", why: "absent" }] };
    expect(renderGrants(input)).toBe(renderGrants(input));
  });
});
