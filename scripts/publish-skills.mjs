// THE GENERATOR. It reads the bodies out of immutable git objects, hands them
// to scripts/skills.mjs — which decides what the set is and says nothing about
// disks — and writes one directory per skill under `--out`.
//
//   node scripts/publish-skills.mjs --wikitom DIR [--commit REF]
//        [--repo NAME=DIR]… --out DIR [--json] [--dry-run]
//
// COMMITTED OBJECTS ONLY. Every body comes from `git show <commit>:<path>`, so
// a dirty work tree — a half-edited area page, a scratch AGENTS.md — changes
// nothing about what is published. That is the whole reason a nightly can run
// on a box whose checkouts nobody promised were clean.
//
// The git helpers below are a deliberate ~20-line copy of the ones in
// scripts/prelude.mjs rather than an import of them. prelude.mjs is the
// retiring assembler and is about to lose `--for`; coupling the generator to a
// module being dismantled would make its removal a two-file change with a
// runtime failure in the middle. Three tiny functions duplicated is the cheaper
// half of that trade.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AREAS_DIR, SKILL_PREFIX, buildSkills, byteLength, renderSkillMd, skillDirName } from "./skills.mjs";

class PublishError extends Error {}

// ── git (see the note above) ─────────────────────────────────────────────────

function git(dir, ...args) {
  const resolved = fs.realpathSync.native(dir);
  return execFileSync("git", ["-c", `safe.directory=${resolved}`, "-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // The one line prelude.mjs does not have. WikiTom holds tens of thousands
    // of archived session files, and `ls-tree -r` over it is megabytes: at
    // the 1 MB default this failed as "cannot list repository", which reads
    // like a broken checkout rather than a truncated pipe.
    maxBuffer: 256 * 1024 * 1024,
  });
}

function resolveCommit(dir, requested) {
  try {
    return git(dir, "rev-parse", "--verify", `${requested}^{commit}`).trim();
  } catch {
    throw new PublishError(`cannot resolve commit ${requested} in ${dir}`);
  }
}

function readObject(dir, commit, file) {
  try {
    return git(dir, "show", `${commit}:${file}`);
  } catch {
    return null;
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** The fixed model-of-tom pages the skill set draws on. The area pages are not
 * here: they are whatever `model-of-tom/areas/` holds at the commit, which is
 * the point of an area — Tom adds a page and the set grows by one. */
const WIKITOM_PAGES = Object.freeze([
  "model-of-tom/agent-rules.md",
  "model-of-tom/writing.md",
  "model-of-tom/ground.md",
  "model-of-tom/intent.md",
  "model-of-tom/priorities.md",
  "model-of-tom/schedule.md",
]);

function areaPaths(dir, commit) {
  let names;
  try {
    names = git(dir, "ls-tree", "--name-only", commit, "--", `${AREAS_DIR}/`);
  } catch {
    return [];
  }
  return names
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.startsWith(`${AREAS_DIR}/`) && /^[^/]+\.md$/.test(name.slice(AREAS_DIR.length + 1)))
    .sort();
}

function readWikitom(dir, commit) {
  const pages = [];
  for (const page of [...WIKITOM_PAGES, ...areaPaths(dir, commit)]) {
    const body = readObject(dir, commit, page);
    if (body === null) continue;
    pages.push({ path: page, body });
  }
  return pages;
}

/**
 * One repository's published rules files, read from ITS OWN HEAD — the same
 * selection `collectRepoRules` makes: `AGENTS.md` at the root and every
 * nested `AGENTS.md` under it. `global_AGENTS.md` is not one of them, which is
 * why the test is on the `/AGENTS.md` suffix and not on the basename.
 */
function readRepo(repo, dir, requested = "HEAD") {
  let commit;
  try {
    commit = resolveCommit(dir, requested);
  } catch {
    throw new PublishError(`cannot read repository ${repo} at ${dir}`);
  }
  let names;
  try {
    names = git(dir, "ls-tree", "-r", "--name-only", commit);
  } catch {
    throw new PublishError(`cannot list repository ${repo} at ${commit}`);
  }
  const files = [];
  for (const file of names
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name === "AGENTS.md" || name.endsWith("/AGENTS.md"))
    .sort()) {
    const body = readObject(dir, commit, file);
    if (body === null || body.trim() === "") continue;
    files.push({ path: file, body });
  }
  return { repo, commit, files };
}

// ── Writing ──────────────────────────────────────────────────────────────────

function sameBytes(target, body) {
  try {
    return Buffer.compare(fs.readFileSync(target), Buffer.from(body, "utf8")) === 0;
  } catch {
    return false;
  }
}

/**
 * The generated files of one skill: its SKILL.md and one file per reference.
 * A reference body is written VERBATIM — it is another repository's own text,
 * and a generated header on top of it would be a second voice inside a file
 * whose author is not this script.
 */
function skillFiles(skill, commit) {
  return [
    { name: "SKILL.md", body: renderSkillMd(skill, commit) },
    ...skill.references.map((reference) => ({ name: reference.name, body: reference.body })),
  ];
}

/**
 * Build the whole set and put it on the disk.
 *
 * Idempotent and write-if-changed: a file whose bytes already match is left
 * alone, so a nightly that publishes an unchanged WikiTom touches nothing and
 * the box's mtimes stay meaningful.
 */
export function publishSkills({ wikitom, commit: requested = "HEAD", repos = [], out, dryRun = false } = {}) {
  if (typeof wikitom !== "string" || wikitom === "") throw new PublishError("--wikitom DIR is required");
  if (typeof out !== "string" || out === "") throw new PublishError("--out DIR is required");
  if (!fs.existsSync(wikitom)) throw new PublishError(`cannot read WikiTom at ${wikitom}`);
  const commit = resolveCommit(wikitom, requested);
  const pages = readWikitom(wikitom, commit);
  const read = repos.map((entry) => readRepo(entry.repo, entry.dir, entry.commit));
  const built = buildSkills({
    commit,
    pages,
    repos: read,
    agentRules: pages.find((page) => page.path === "model-of-tom/agent-rules.md")?.body,
  });

  const outDir = path.resolve(out);
  const produced = new Map();
  for (const skill of built.skills) produced.set(skillDirName(skill.name), skillFiles(skill, commit));

  const deleted = [];
  const reported = [];

  // THE DELETION RULE, and it is narrow on purpose: only a directory directly
  // under `--out` whose name starts with `tom-` and which this build did not
  // produce. A skills directory holds other people's skills — `graphify/`, a
  // checkout's own — and a generator that tidied them would lose work nobody
  // asked it to manage. Inside a directory this build DOES own, a file it no
  // longer produces is a ghost of a renamed reference, and that one goes.
  if (fs.existsSync(outDir)) {
    for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(SKILL_PREFIX)) continue;
      if (produced.has(entry.name)) continue;
      deleted.push(entry.name);
      if (!dryRun) fs.rmSync(path.join(outDir, entry.name), { recursive: true, force: true });
    }
  }

  for (const skill of built.skills) {
    const dirName = skillDirName(skill.name);
    const dir = path.join(outDir, dirName);
    const files = produced.get(dirName);
    const keep = new Set(files.map((file) => file.name));
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() || keep.has(entry.name)) continue;
        deleted.push(`${dirName}/${entry.name}`);
        if (!dryRun) fs.rmSync(path.join(dir, entry.name), { force: true });
      }
    }
    let wrote = 0;
    let unchanged = 0;
    for (const file of files) {
      const target = path.join(dir, file.name);
      if (sameBytes(target, file.body)) {
        unchanged += 1;
        continue;
      }
      wrote += 1;
      if (dryRun) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, file.body, "utf8");
    }
    reported.push({
      name: skill.name,
      group: skill.group,
      descriptionBytes: byteLength(skill.description),
      bodyBytes: skill.bytes,
      references: skill.references.map((reference) => reference.name),
      wrote,
      unchanged,
    });
  }

  return { commit, out: outDir, skills: reported, refused: built.refused, deleted };
}

// ── Command line ─────────────────────────────────────────────────────────────

const VALUE_ARGS = ["--wikitom", "--commit", "--out", "--repo"];

function parseArgs(argv) {
  const values = {};
  const repos = [];
  let json = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!VALUE_ARGS.includes(argument)) throw new PublishError(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new PublishError(`${argument} needs a value`);
    index += 1;
    if (argument === "--repo") {
      const split = value.indexOf("=");
      if (split <= 0) throw new PublishError(`--repo wants NAME=DIR, not ${value}`);
      repos.push({ repo: value.slice(0, split), dir: value.slice(split + 1) });
      continue;
    }
    values[argument.slice(2)] = value;
  }
  if (values.wikitom === undefined) throw new PublishError("--wikitom DIR is required");
  if (values.out === undefined) throw new PublishError("--out DIR is required");
  return { ...values, repos, json, dryRun };
}

function main(argv) {
  const { json, ...options } = parseArgs(argv);
  const result = publishSkills(options);
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const wrote = result.skills.reduce((total, skill) => total + skill.wrote, 0);
  process.stdout.write(
    `${result.skills.length} skills at ${result.commit.slice(0, 12)} -> ${result.out} (${wrote} files written, ${result.deleted.length} removed)\n`,
  );
  for (const skill of result.skills) {
    process.stdout.write(`  ${skill.name} [${skill.group}] ${skill.descriptionBytes}B desc, ${skill.bodyBytes}B body\n`);
  }
  for (const entry of result.refused) process.stdout.write(`  refused ${entry.name}: ${entry.why}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`publish-skills: ${error.message}`);
    process.exitCode = 2;
  }
}
