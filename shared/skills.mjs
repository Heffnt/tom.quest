// THE ONE DEFINITION of the published skill set, and of the prompt's stable
// layers while they retire.
//
// Two things live here because two runtimes read them and neither can hold the
// other's language:
//
//   PRELUDE_LAYERS — the retiring side. scripts/prelude.mjs builds the nightly
//     publication out of a WikiTom commit with it, and convex/ttsSkills.ts's
//     one-shot backfill rebuilds the same publication out of the per-file rows
//     already stored. Neither keeps a second copy of the selection.
//   The skill machinery — the arriving side. scripts/publish-skills.mjs reads
//     the bodies out of git and writes the directories; this file decides what
//     the set IS, what each description says, and what the grant block looks
//     like, so a description is never authored twice and never drifts.
//
// THIS FILE IS PURE. No node:fs, no node:path, no node:child_process, no I/O of
// any kind, and no Buffer — convex/ttsSkills.ts imports it and the Convex
// bundler takes no node builtins, so byte lengths are counted with TextEncoder.
// Everything that touches a disk or a git object lives in publish-skills.mjs.

import { parseFrontmatter } from "./markdown-sections.mjs";

export class SkillsError extends Error {}

// ── The retiring layers ──────────────────────────────────────────────────────

/**
 * @typedef {{ path: string, optional?: boolean, optionalUntilPresent?: boolean }} PreludeFile
 * @typedef {{ directory: string, required: readonly string[] }} PreludeAreas
 * @typedef {{ files: readonly PreludeFile[], areas?: PreludeAreas }} PreludeLayer
 */

/** @type {Readonly<Record<"operate" | "write" | "know", Readonly<PreludeLayer>>>} */
export const PRELUDE_LAYERS = Object.freeze({
  operate: Object.freeze({
    files: Object.freeze([{ path: "model-of-tom/agent-rules.md", optional: false }]),
  }),
  write: Object.freeze({
    files: Object.freeze([
      { path: "model-of-tom/writing.md", optional: false },
      { path: "model-of-tom/ground.md", optionalUntilPresent: true },
    ]),
  }),
  know: Object.freeze({
    files: Object.freeze([
      { path: "model-of-tom/intent.md", optional: false },
      { path: "model-of-tom/priorities.md", optional: false },
      { path: "model-of-tom/schedule.md", optional: false },
    ]),
    areas: Object.freeze({
      directory: "model-of-tom/areas",
      required: Object.freeze([
        "model-of-tom/areas/admin.md",
        "model-of-tom/areas/agent-systems.md",
        "model-of-tom/areas/climbing.md",
        "model-of-tom/areas/health-and-food.md",
        "model-of-tom/areas/mental-health.md",
        "model-of-tom/areas/money.md",
        "model-of-tom/areas/research.md",
        "model-of-tom/areas/social.md",
      ]),
    }),
  }),
});

export const PRELUDE_LAYER_NAMES = Object.freeze(Object.keys(PRELUDE_LAYERS));

// ── Skill constants ──────────────────────────────────────────────────────────

/** Every published directory is `tom-<name>`. The prefix is a directory-naming
 * fact only: it keeps Tom's skills apart from a checkout's own in one skills
 * directory. It is NEVER part of what a prompt says — see renderGrants. */
export const SKILL_PREFIX = "tom-";
// Kept beside SKILL.md rather than in its frontmatter: Codex uses only `name`
// and `description` to discover a skill, while launchers need immutable
// publication provenance after discovery.
export const PUBLISHED_SKILL_METADATA = ".tom-skill.json";

export const SKILL_GROUPS = Object.freeze(["write", "know", "repo"]);

/** The hard cap a skill description is written to. It is a prompt cost paid by
 * every run whether or not the skill is loaded, so it is a byte count, not a
 * character count, and it is checked rather than trusted. */
export const DESCRIPTION_MAX_BYTES = 200;

export const AREAS_DIR = "model-of-tom/areas";

const WRITING_PATH = "model-of-tom/writing.md";
const GROUND_PATH = "model-of-tom/ground.md";
const EXPLAINERS_PATH = "model-of-tom/explainers.md";
const INTENT_PATH = "model-of-tom/intent.md";
const PRIORITIES_PATH = "model-of-tom/priorities.md";
const SCHEDULE_PATH = "model-of-tom/schedule.md";
const AGENT_RULES_PATH = "model-of-tom/agent-rules.md";
const ROOT_RULES = "AGENTS.md";

/** The origin named in a generated page's provenance comment. */
const WIKITOM = "WikiTom";

const ELLIPSIS = "…";

/**
 * THE THREE SHAPES a description takes, spelled once.
 *
 * `base` is fixed text (a `{name}` token is filled with the skill's variable
 * name); `tail` is the part that comes out of the page and is therefore the
 * part that may be truncated; `suffix` is fixed text kept WHOLE after the
 * truncation point, so a sentence that tells a run when to load the skill is
 * never the half that gets cut.
 *
 * `week` has no tail at all: its one page is a fixed subject, so a generated
 * summary of its headings would say less than the sentence below. `explainer`
 * has none for the same reason: its page is the form of one kind of document.
 */
export const SKILL_SHAPES = Object.freeze({
  write: Object.freeze({
    group: "write",
    base:
      "Load before writing anything Tom reads — a report, an explanation, a Slack message, a digest line. His writing standard: ",
    suffix: "",
  }),
  explainer: Object.freeze({
    group: "write",
    base:
      "Load before writing an HTML explainer for Tom — of a plan, a change, a ruling, or a component of code.",
    suffix: "",
    fixed: true,
  }),
  area: Object.freeze({
    group: "know",
    base: "Tom's {name}: ",
    suffix: " Load before planning, judging or deciding anything in this area.",
  }),
  intent: Object.freeze({
    group: "know",
    base:
      "What Tom wants to be true and the rules for judging on his behalf. Load before any plan, priority call, or decision made for him. Covers: ",
    suffix: "",
  }),
  week: Object.freeze({
    group: "know",
    base:
      "Tom's recurring week: what happens on which day, and the fixed commitments. Load before scheduling, before reading a date, and before writing anything about his day.",
    suffix: "",
    fixed: true,
  }),
  repo: Object.freeze({
    group: "repo",
    base: "Rules of the {name} repository, for a run reasoning about it with no checkout of it open. ",
    suffix: "",
  }),
});

// ── Bytes ────────────────────────────────────────────────────────────────────
// TextEncoder, not Buffer: Convex bundles this file into a runtime that has the
// former and not the latter.

const ENCODER = new TextEncoder();

export function byteLength(text) {
  return ENCODER.encode(String(text ?? "")).length;
}

/**
 * `text` cut to at most `budget` bytes, at a word boundary, with a trailing `…`
 * when anything was cut. Returns `{ text, truncated }`.
 *
 * The boundary is the last run of whitespace inside the byte budget; a trailing
 * comma or dash left by the cut goes with it, so a truncated list never ends
 * `agents,…`. A budget too small for even one word yields the ellipsis alone
 * rather than a fragment of a word.
 */
export function truncateToBytes(text, budget) {
  const source = String(text ?? "");
  if (byteLength(source) <= budget) return { text: source, truncated: false };
  const room = budget - byteLength(ELLIPSIS);
  if (room <= 0) return { text: "", truncated: true };
  // Walk code POINTS, not units, so a cut never lands inside a surrogate pair.
  let kept = "";
  let cutPoint = "";
  for (const point of source) {
    if (byteLength(kept + point) > room) {
      cutPoint = point;
      break;
    }
    kept += point;
  }
  // A non-space next point means the fitted prefix split a word. Retain only
  // a preceding complete word; without one, return the ellipsis alone.
  if (cutPoint !== "" && !/\s/.test(cutPoint)) {
    const boundary = kept.search(/\s+\S*$/);
    kept = boundary > 0 ? kept.slice(0, boundary) : "";
  }
  kept = kept.replace(/[\s,;:—-]+$/, "");
  return { text: `${kept}${ELLIPSIS}`, truncated: true };
}

// ── Names ────────────────────────────────────────────────────────────────────

/** The two runners accept these forms for a skill's frontmatter name. The
 * stricter Codex form excludes an empty segment, so every generated name meets
 * both contracts rather than relying on the publisher a run happens to use. */
export const CLAUDE_SKILL_NAME = /^[a-z0-9-]+$/;
export const CODEX_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSupportedSkillName(name) {
  const text = String(name ?? "");
  return CLAUDE_SKILL_NAME.test(text) && CODEX_SKILL_NAME.test(text);
}

/**
 * The one spelling of a generated bare skill name. Punctuation is a separator,
 * not part of an identifier: `repo-tom.quest` and `repo-tom quest` both become
 * `repo-tom-quest`. Callers that supply multiple repositories detect that
 * collision before publishing either one.
 */
export function bareSkillName(name) {
  const bare = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (bare === "") throw new SkillsError("a skill needs a name with a letter or digit");
  if (!isSupportedSkillName(bare)) throw new SkillsError(`unsupported generated skill name ${bare}`);
  return bare;
}

/** `repo-tom-quest` from the repository label `tom.quest`. */
export function repoSkillName(repo) {
  const repository = bareSkillName(repo);
  return bareSkillName(`repo-${repository}`);
}

/** `tom-know-research` from `know-research`. The directory name IS the
 * canonical id: the frontmatter `name`, the grant block's name with the prefix
 * off, and the directory are one string with one source. */
export function skillDirName(name) {
  const full = `${SKILL_PREFIX}${bareSkillName(name)}`;
  if (!isSupportedSkillName(full)) throw new SkillsError(`unsupported generated skill name ${full}`);
  return full;
}

/** `research` from `model-of-tom/areas/research.md`. */
export function areaName(path) {
  const text = String(path ?? "");
  if (!text.startsWith(`${AREAS_DIR}/`)) throw new SkillsError(`${text} is not an area page`);
  return text.slice(AREAS_DIR.length + 1).replace(/\.md$/, "");
}

export function isAreaPath(path) {
  const text = String(path ?? "");
  return text.startsWith(`${AREAS_DIR}/`) && /^[^/]+\.md$/.test(text.slice(AREAS_DIR.length + 1));
}

/** A nested rules file's flattened reference name: `convex/AGENTS.md` →
 * `convex__AGENTS.md`. One directory holds them all, so the path has to survive
 * as a name. `__` does not turn a directory boundary into a hyphen already in
 * a directory name; buildSkills also rejects the remaining ambiguous spellings
 * before a publisher can overwrite either source. */
export function referenceName(path) {
  return String(path ?? "").replace(/\//g, "__");
}

// ── Area categories ──────────────────────────────────────────────────────────

/**
 * The categories of one area page: lowercased, de-duplicated, and with the
 * page's own name first. `parseFrontmatter` converts the bracket-list form into
 * the normalized array that this function consumes.
 */
export function areaCategories(path, source) {
  const { fields } = parseFrontmatter(source);
  const declared = (Array.isArray(fields.categories) ? fields.categories : [])
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term !== "");
  return [...new Set([areaName(path).toLowerCase(), ...declared])];
}

// ── The map's Repos block ────────────────────────────────────────────────────

const REPOS_HEADING = /^\s{0,3}###\s+Repos\s*$/;
const ANY_HEADING = /^\s{0,3}#{2,6}\s/;
const BULLET = /^\s{0,3}-\s+(.*)$/;

/**
 * The Repos bullets of agent-rules.md's map, parsed into the names each one
 * covers and the line itself.
 *
 * A bullet with no colon, or with an empty name list, THROWS with the bullet
 * quoted. This is Tom's own text and the only place a repository's one-line
 * description exists: a silent skip would publish a `repo-` skill whose
 * description said nothing about the repository, which is worse than a run that
 * stops and shows him the line that broke.
 */
export function parseRepoBullets(agentRulesText) {
  const lines = String(agentRulesText ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => REPOS_HEADING.test(line));
  if (start === -1) throw new SkillsError("model-of-tom/agent-rules.md has no `### Repos` block");
  const bullets = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (ANY_HEADING.test(line)) break;
    const match = BULLET.exec(line);
    if (match === null) continue;
    const text = match[1].trim();
    const colon = text.indexOf(":");
    if (colon === -1) throw new SkillsError(`\`### Repos\` bullet has no colon: "${text}"`);
    const aliases = {};
    const names = [];
    for (const entry of text.slice(0, colon).split(",")) {
      const name = entry.trim();
      if (name === "") continue;
      const parenthetical = /^(.*?)\s*\(([^()]*)\)$/.exec(name);
      if (parenthetical === null) {
        names.push(name);
        continue;
      }
      const bare = parenthetical[1].trim();
      if (bare === "") continue;
      names.push(bare);
      aliases[bare] = parenthetical[2].trim();
    }
    if (names.length === 0) throw new SkillsError(`\`### Repos\` bullet names no repository: "${text}"`);
    bullets.push({ names, aliases, line: text });
  }
  return bullets;
}

// ── Descriptions ─────────────────────────────────────────────────────────────

function atxHeadings(text, level) {
  const mark = "#".repeat(level);
  const pattern = new RegExp(`^\\s{0,3}${mark}[ \\t]+(.+?)[ \\t]*#*[ \\t]*$`, "gm");
  return [...new Set([...String(text ?? "").matchAll(pattern)].map((match) => match[1].trim()))].filter(
    (heading) => heading !== "",
  );
}

function assembleDescription({ base, tail, suffix, endTail }) {
  const fixed = byteLength(base) + byteLength(suffix);
  if (fixed > DESCRIPTION_MAX_BYTES) {
    // The base is written here, not read from a page: over the cap it is a bug
    // in this file's text, and no input can fix it.
    throw new SkillsError(
      `skill description base is ${fixed} bytes, over the ${DESCRIPTION_MAX_BYTES}-byte cap: "${base}"`,
    );
  }
  if (tail === undefined || tail === "") return `${base}${suffix}`.trimEnd();
  const budget = DESCRIPTION_MAX_BYTES - fixed - (endTail === undefined ? 0 : byteLength(endTail));
  const cut = truncateToBytes(tail, Math.max(budget, 0));
  // A truncated tail ends in `…`, which stands in for the terminator; an intact
  // one keeps it, so the description reads as a finished sentence either way.
  const ended = cut.truncated || endTail === undefined ? cut.text : `${cut.text}${endTail}`;
  return `${base}${ended}${suffix}`;
}

/**
 * ONE description, generated. Never authored — a hand-written description is a
 * second statement of what a page is for, and the two drift the first time Tom
 * edits the page.
 *
 * A page may carry a `skill:` frontmatter line; that REPLACES the generated
 * text verbatim, and is still checked against the cap. Generated descriptions
 * are necessarily lossy, so Tom needs this escape hatch for a page whose
 * discovery wording is itself material.
 */
export function describe(skill) {
  const shape = SKILL_SHAPES[skill.shape];
  if (shape === undefined) throw new SkillsError(`unknown skill shape ${skill.shape}`);
  if (skill.override !== undefined && skill.override !== "") {
    const bytes = byteLength(skill.override);
    if (bytes > DESCRIPTION_MAX_BYTES) {
      throw new SkillsError(
        `${skill.overridePath ?? skill.name}: its \`skill:\` description is ${bytes} bytes, over the ${DESCRIPTION_MAX_BYTES}-byte cap`,
      );
    }
    return skill.override;
  }
  const base = shape.base.replace("{name}", String(skill.variable ?? ""));
  const description =
    shape.fixed === true
      ? assembleDescription({ base, tail: "", suffix: shape.suffix })
      : assembleDescription({
          base,
          tail: skill.tail ?? "",
          suffix: shape.suffix,
          endTail: skill.shape === "area" ? "." : undefined,
        });
  const bytes = byteLength(description);
  if (bytes > DESCRIPTION_MAX_BYTES) {
    throw new SkillsError(`${skill.name}: description is ${bytes} bytes, over the ${DESCRIPTION_MAX_BYTES}-byte cap`);
  }
  return description;
}

// ── The set ──────────────────────────────────────────────────────────────────

const BLOCK = "──";

/** The layer assembler's join, so a two-file skill body reads the way the same
 * two files read in a prompt: `── <path> ──` over each, a blank line between. */
function joinSources(sources) {
  if (sources.length === 1) return sources[0].body;
  return sources.map(({ path, body }) => `${BLOCK} ${path} ${BLOCK}\n${body}`).join("\n\n");
}

function pageBody(page) {
  return isAreaPath(page.path) ? parseFrontmatter(page.body).body.trim() : String(page.body ?? "").trim();
}

function present(page) {
  return page !== undefined && pageBody(page) !== "";
}

function override(page) {
  const value = parseFrontmatter(page.body).fields.skill;
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function byPathOrder(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * EVERYTHING, from already-read text. No I/O — the caller has read the bodies
 * out of git (publish-skills.mjs) or out of Convex rows, and this decides only
 * what the set is.
 *
 * A source that is absent or blank is a REFUSAL, not a throw: WikiTom is Tom's
 * to edit, and a nightly that died because he emptied a page would take the
 * other thirteen skills down with it. A REFERENCE that is absent is simply not
 * a reference; ground.md has been optional-until-present since the layers, and
 * a repo may have no nested rules at all.
 */
export function buildSkills({ commit, pages = [], repos = [] } = {}) {
  const byPath = new Map(pages.map((page) => [page.path, page]));
  const skills = [];
  const refused = [];
  const generatedNames = new Map();

  // Two repository labels can differ only by punctuation, while the runners
  // cannot keep that punctuation in a skill name. This preflight cannot defer
  // to add(): an unmapped second label is refused before it reaches add(),
  // which would otherwise hide a conflicting repository behind that refusal.
  const repoNames = new Map();
  for (const entry of repos) {
    const name = repoSkillName(entry.repo);
    const first = repoNames.get(name);
    if (first !== undefined) {
      throw new SkillsError(`repository names ${JSON.stringify(first)} and ${JSON.stringify(entry.repo)} both map to ${name}`);
    }
    repoNames.set(name, entry.repo);
  }

  const add = (skill) => {
    const name = bareSkillName(skill.name);
    const first = generatedNames.get(name);
    if (first !== undefined) {
      throw new SkillsError(`skill names ${JSON.stringify(first)} and ${JSON.stringify(skill.name)} both map to ${name}`);
    }
    generatedNames.set(name, skill.name);
    const description = describe({ ...skill, name });
    skills.push({
      name,
      group: SKILL_SHAPES[skill.shape].group,
      shape: skill.shape,
      description,
      body: skill.body,
      sourcePaths: skill.sourcePaths,
      references: skill.references ?? [],
      origin: skill.origin ?? WIKITOM,
      commit: skill.commit ?? commit,
      bytes: byteLength(skill.body),
    });
  };

  const refuse = (name, why) => {
    refused.push({ name: bareSkillName(name), why });
  };

  const state = (path, page) => `${path} is ${page === undefined ? "absent" : "blank"} at this commit`;

  // write ────────────────────────────────────────────────────────────────────
  const writing = byPath.get(WRITING_PATH);
  if (!present(writing)) {
    refuse("write", state(WRITING_PATH, writing));
  } else {
    const ground = byPath.get(GROUND_PATH);
    add({
      name: "write",
      shape: "write",
      variable: "",
      tail: atxHeadings(writing.body, 2).join(", "),
      override: override(writing),
      overridePath: WRITING_PATH,
      body: pageBody(writing),
      sourcePaths: [WRITING_PATH],
      references: present(ground) ? [{ name: "ground.md", path: GROUND_PATH, body: pageBody(ground) }] : [],
    });
  }

  // explainer ────────────────────────────────────────────────────────────────
  const explainers = byPath.get(EXPLAINERS_PATH);
  if (!present(explainers)) {
    refuse("explainer", state(EXPLAINERS_PATH, explainers));
  } else {
    add({
      name: "explainer",
      shape: "explainer",
      variable: "",
      override: override(explainers),
      overridePath: EXPLAINERS_PATH,
      body: pageBody(explainers),
      sourcePaths: [EXPLAINERS_PATH],
    });
  }

  // know-intent ──────────────────────────────────────────────────────────────
  const intent = byPath.get(INTENT_PATH);
  const priorities = byPath.get(PRIORITIES_PATH);
  const missing = [
    [INTENT_PATH, intent],
    [PRIORITIES_PATH, priorities],
  ].filter(([, page]) => !present(page));
  if (missing.length > 0) {
    refuse("know-intent", missing.map(([path, page]) => state(path, page)).join("; "));
  } else {
    add({
      name: "know-intent",
      shape: "intent",
      variable: "",
      tail: atxHeadings(intent.body, 2).join(", "),
      override: override(intent),
      overridePath: INTENT_PATH,
      body: joinSources([
        { path: INTENT_PATH, body: pageBody(intent) },
        { path: PRIORITIES_PATH, body: pageBody(priorities) },
      ]),
      sourcePaths: [INTENT_PATH, PRIORITIES_PATH],
    });
  }

  // know-week ────────────────────────────────────────────────────────────────
  const schedule = byPath.get(SCHEDULE_PATH);
  if (!present(schedule)) {
    refuse("know-week", state(SCHEDULE_PATH, schedule));
  } else {
    add({
      name: "know-week",
      shape: "week",
      variable: "",
      override: override(schedule),
      overridePath: SCHEDULE_PATH,
      body: pageBody(schedule),
      sourcePaths: [SCHEDULE_PATH],
    });
  }

  // know-<area> ──────────────────────────────────────────────────────────────
  for (const page of pages.filter((candidate) => isAreaPath(candidate.path)).sort(byPathOrder)) {
    const name = `know-${areaName(page.path)}`;
    if (!present(page)) {
      refuse(name, state(page.path, page));
      continue;
    }
    add({
      name,
      shape: "area",
      variable: areaName(page.path),
      tail: areaCategories(page.path, page.body).join(", "),
      override: override(page),
      overridePath: page.path,
      body: pageBody(page),
      sourcePaths: [page.path],
    });
  }

  // repo-<name> ──────────────────────────────────────────────────────────────
  if (repos.length > 0) {
    const map = byPath.get(AGENT_RULES_PATH);
    const rulesText = map === undefined ? undefined : map.body;
    const bullets = rulesText === undefined || String(rulesText).trim() === "" ? null : parseRepoBullets(rulesText);
    for (const entry of repos) {
      const name = repoSkillName(entry.repo);
      if (bullets === null) {
        refuse(name, `${AGENT_RULES_PATH} is absent at this commit, so the map names no repository`);
        continue;
      }
      const bullet = bullets.find((candidate) =>
        candidate.names.some(
          (candidateName) =>
            candidateName.toLowerCase() === entry.repo.toLowerCase() ||
            String(candidate.aliases[candidateName] ?? "").toLowerCase() === entry.repo.toLowerCase(),
        ),
      );
      if (bullet === undefined) {
        refuse(name, "the map's `### Repos` block does not name it");
        continue;
      }
      const files = (entry.files ?? []).filter((file) => String(file.body ?? "").trim() !== "").sort(byPathOrder);
      const root = files.find((file) => file.path === ROOT_RULES);
      if (root === undefined) {
        refuse(name, "no published body at this commit");
        continue;
      }
      const references = files
        .filter((file) => file.path !== ROOT_RULES)
        .map((file) => ({ name: referenceName(file.path), path: file.path, body: file.body }));
      const referencePaths = new Map();
      for (const reference of references) {
        const first = referencePaths.get(reference.name);
        if (first !== undefined) {
          throw new SkillsError(
            `reference name ${JSON.stringify(reference.name)} collides for ${JSON.stringify(first)} and ${JSON.stringify(reference.path)}`,
          );
        }
        referencePaths.set(reference.name, reference.path);
      }
      add({
        name,
        shape: "repo",
        variable: entry.repo,
        tail: bullet.line,
        body: String(root.body).trim(),
        sourcePaths: [ROOT_RULES],
        origin: entry.repo,
        commit: entry.commit ?? commit,
        references,
      });
    }
  }

  return { skills, refused };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * The SKILL.md text for one skill. The frontmatter carries `name` and
 * `description` and NOTHING else: those two are the whole of what a run sees
 * before it decides to load the skill, and a third field is a third thing to
 * keep true. The description is JSON-quoted so a `"` or a `:` inside it cannot
 * break the block.
 *
 * `skill.commit` wins over the argument, because a `repo-` skill's body came
 * out of that repository's own HEAD rather than out of WikiTom — and a
 * provenance line that named the wrong commit would be worse than none.
 */
export function renderSkillMd(skill, commit) {
  const at = skill.commit ?? commit;
  const frontmatter = [
    "---",
    `name: ${skillDirName(skill.name)}`,
    `description: ${JSON.stringify(skill.description)}`,
    "---",
  ].join("\n");
  const provenance = `<!-- generated from ${skill.origin ?? WIKITOM} ${skill.sourcePaths.join(", ")} at commit ${at} — do not edit -->`;
  const references = Array.isArray(skill.references) && skill.references.length > 0
    ? `\n\n## References\n\nThe following files are beside this SKILL.md; read the ones relevant to the task:\n${skill.references.map((reference) => `- \`${reference.name}\``).join("\n")}`
    : "";
  return `${frontmatter}\n\n${provenance}\n\n${skill.body}${references}\n`;
}

/** The catalog commit attached to every file produced in one publication. */
export function renderSkillMetadata(commit) {
  return `${JSON.stringify({ commit })}\n`;
}

/**
 * THE ONE RENDERER of the grant block — the lines a run's prompt carries to say
 * which skills it was given. Byte-identical for the same input, because it sits
 * inside the cached prefix of every prompt that carries it.
 *
 * Names are BARE. `tom-` is how a directory is spelled on a disk; a run is told
 * to load `know-research`, and the harness resolves the directory.
 */
export function renderGrants({ commit, checkoutCommit = null, granted = [], refused = [] }) {
  const lines = [`SKILLS (WikiTom commit ${commit})`];
  if (checkoutCommit && checkoutCommit !== commit) lines.push(`skills at ${commit}, checkout at ${checkoutCommit}`);
  lines.push(`granted: ${granted.length === 0 ? "—" : granted.map(bareSkillName).join(", ")}`);
  if (refused.length > 0) {
    lines.push(
      `refused: ${refused.map((entry) => `${bareSkillName(entry.name)} — ${entry.why}`).join("; ")}`,
    );
  }
  lines.push("Load each granted skill before you act on what it covers. `tts-search skills` lists the rest.");
  return lines.join("\n");
}
