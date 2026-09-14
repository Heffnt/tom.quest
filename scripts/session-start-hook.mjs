// The SessionStart hook, on the laptop and on the box. It does TWO things, and
// they are independent on purpose:
//
//   1. It REFRESHES THE SKILL CATALOG — `~/.claude/skills` and `~/.codex/skills`
//      — out of WikiTom's committed objects and out of the checkouts that are
//      present. A laptop has no nightly, so the session start is the only moment
//      that reliably happens; publish-skills.mjs is write-if-changed, so a
//      session after a quiet night writes nothing at all.
//   2. It EMITS THE CONTEXT a run cannot work without: the operate layer, and
//      the grant block naming the skills this run may load.
//
// THE NUMBER THIS ROUND IS ABOUT. It used to emit
// `assemblePrelude({ for: "laptop" })` — the operate layer, the write layer and
// the FETCHABLE index — 19,823 bytes when the round was briefed and 19,775
// measured against WikiTom at b82a890. It now emits the operate layer and the
// grant block: 7,309 bytes at that same commit, 63% off every session start.
// The write layer did not disappear; it became the `write` skill, granted by
// name below and loaded by the run that is about to write something Tom reads.
// The fetchable index went with it — the harness lists the skills directory
// already, and a second index of it inside the prompt is a second answer.
//
// NOTHING HERE MAY FAIL A SESSION START. The three steps carry three separate
// `try` blocks because they are three different failures: an unreachable
// WikiTom, an unwritable skills directory, and an unreadable operate layer.
// THE BASE IS FATAL, A SKILL IS NOT — a run that cannot get operate says so in
// one line (the hook cannot refuse a session start, so it tells the run
// instead), while a skill that could not be fetched is recorded REFUSED in the
// grant block and the session carries on with everything else it has.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assemblePrelude } from "./prelude.mjs";
import { publishSkills } from "./publish-skills.mjs";
import { SKILL_PREFIX, renderGrants } from "./skills.mjs";
import { routeSkills } from "../worker/jobs/skill-router.mjs";

function relativeModulePath(relative) {
  try { return fileURLToPath(new URL(relative, import.meta.url)); } catch { return null; }
}

const registrationPath = [
  relativeModulePath("../worker/runs/registration.mjs"),
  relativeModulePath("../runs/registration.mjs"),
  // Vitest gives an imported module a Vite URL, so only its checkout-relative
  // path is file-shaped there. The direct hook keeps the two installed layouts.
  path.resolve(process.cwd(), "worker/runs/registration.mjs"),
].find((candidate) => candidate !== null && existsSync(candidate));
const registration = registrationPath ? await import(pathToFileURL(registrationPath).href) : null;

const wikitom = process.env.WIKITOM_DIR
  || (process.platform === "win32" ? "C:/Users/heffn/Desktop/WikiTom" : "/root/wikitom");

function oneLine(value) {
  return String(value?.message ?? value).replace(/\s+/g, " ").trim();
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "") ?? null;
}

function sessionRunFile(payload) {
  const value = firstString(
    payload?.transcript_path,
    payload?.transcriptPath,
    payload?.rollout_path,
    payload?.rolloutPath,
    payload?.run_file,
    payload?.runFile,
  );
  return value === null ? null : path.resolve(value);
}

// The run lifecycle hook never receives this hook's rendered text. Hand the
// exact lists over through the registration sidecar, so diagnostics match a
// successful refusal as well as an ordinary grant.
function recordGrantReceipt(payload, { granted, refused }) {
  const runFile = sessionRunFile(payload);
  if (runFile === null || registration === null) return;
  try {
    registration.writeRegistrationClaim({
      runFile,
      claim: { by: "hook:session-start-grants", runFile },
      registration: {
        skillsGranted: [...granted],
        skillsRefused: refused.map((entry) => entry.name),
      },
    });
  } catch {
    // A diagnostic receipt must never make the launcher fail.
  }
}

// A session start WAITS for this hook, so the refresh is capped: a slow fetch
// (one laptop session spent two minutes here) is killed and skipped, and the
// session goes on with whatever local HEAD WikiTom already has.
export const PULL_TIMEOUT_MS = 15_000;

/** Fast-forward WikiTom when it is present, reachable and quick. Never throws. */
export function pullWikiTom(dir, run = execFileSync) {
  if (!existsSync(dir)) return false;
  try {
    run("git", ["-C", dir, "pull", "--ff-only", "--quiet"], {
      stdio: "ignore",
      timeout: PULL_TIMEOUT_MS,
    });
    return true;
  } catch {
    // Offline, slow, or a divergent checkout still has a usable local HEAD.
    return false;
  }
}

// ── The two skills directories ───────────────────────────────────────────────

/**
 * Where the catalog goes: the Claude skills directory and the Codex one.
 *
 * THE TEST SEAM, and the only one: `TTS_SKILLS_DIRS` is a `;`-separated list of
 * destinations that REPLACES both (`;` and not `:` because a Windows path
 * carries a colon). When it names two, Claude is first and Codex second, the
 * same order as the ordinary destinations. A test points both at one temp
 * directory with it; nothing else in the tree reads it.
 *
 * `CLAUDE_CONFIG_DIR` moves the Claude half, because the harness itself reads
 * its skills from there when it is set, and writing to `~/.claude/skills` would
 * then publish into a directory nobody loads.
 */
export function skillsDestinations() {
  const override = process.env.TTS_SKILLS_DIRS;
  if (override !== undefined && override.trim() !== "") {
    return override
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
      .map((entry) => path.resolve(entry));
  }
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const claudeConfig = process.env.CLAUDE_CONFIG_DIR;
  const claude = claudeConfig !== undefined && claudeConfig.trim() !== ""
    ? path.join(claudeConfig, "skills")
    : path.join(home, ".claude", "skills");
  const codex = process.env.CODEX_HOME && process.env.CODEX_HOME.trim() !== ""
    ? process.env.CODEX_HOME
    : path.join(home, ".codex");
  return [path.resolve(claude), path.resolve(codex, "skills")];
}

/** Every repository a `repo-` skill could come from, by the name the map's
 * `### Repos` block spells it with. DIRECTORIES, NOT CHECKOUTS: the cwd rule in
 * skill-router.mjs asks whether a run stands inside one, and that question has
 * an answer whether or not the directory holds a `.git`. */
export function skillRepoDirs() {
  const dirs = {
    "tom.quest": process.env.TOM_QUEST_DIR
      || (process.platform === "win32" ? "C:/Users/heffn/Desktop/tom.quest" : "/root/tom.quest"),
    WikiTom: wikitom,
    // THE SAME DEFAULT worker/jobs/nightly.mjs CMT_DIR carries, so the laptop
    // and the box publish the same fourteen rather than thirteen and fourteen.
    // A directory that is not a checkout is skipped below, so naming one that
    // may be absent costs nothing.
    ComplexMultiTrigger: process.env.CMT_DIR
      || (process.platform === "win32" ? "C:/Users/heffn/Desktop/booleanbackdoor/ComplexMultiTrigger" : "/var/cache/tts/ComplexMultiTrigger"),
  };
  return dirs;
}

/** The ones publish-skills.mjs can actually read. A DIRECTORY THAT IS NOT A
 * CHECKOUT IS SKIPPED, NOT AN ERROR: a laptop with no CMT clone, or a box whose
 * tom.quest lives somewhere else, publishes the rest of the catalog rather than
 * publishing none of it. */
export function skillRepos(dirs = skillRepoDirs()) {
  return Object.entries(dirs)
    .map(([repo, dir]) => ({ repo, dir }))
    .filter(({ dir }) => typeof dir === "string" && dir !== "" && existsSync(path.join(dir, ".git")));
}

/**
 * Publish the catalog into every destination. Never throws: each directory's
 * failure is its own row, so an unwritable Codex directory does not cost the
 * Claude one its refresh.
 *
 * @returns {{ dir: string, ok: boolean, changed?: boolean, skills?: number, commit?: string, why?: string }[]}
 */
export function refreshSkills({ wikitom: dir = wikitom, dirs = skillsDestinations(), repos = skillRepos() } = {}) {
  const results = [];
  for (const out of dirs) {
    try {
      mkdirSync(out, { recursive: true });
      const published = publishSkills({ wikitom: dir, repos, out });
      const wrote = published.skills.reduce((total, skill) => total + skill.wrote, 0);
      results.push({
        dir: out,
        ok: true,
        changed: wrote > 0 || published.deleted.length > 0,
        skills: published.skills.length,
        commit: published.commit,
      });
    } catch (error) {
      results.push({ dir: out, ok: false, why: oneLine(error) });
    }
  }
  return results;
}

const WIKITOM_PROVENANCE = /^<!-- generated from WikiTom .+ at commit ([0-9a-f]+) — do not edit -->$/m;

/** The catalog AS IT STANDS ON THE DISK, bare-named and with the WikiTom
 * commit its bodies name. This is one harness directory, never their union:
 * SessionStart is a Claude hook, while Codex reads its own directory elsewhere. */
export function publishedCatalog(dir) {
  const names = new Set();
  const commits = new Set();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { names, commit: null };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SKILL_PREFIX)) continue;
    try {
      const skill = readFileSync(path.join(dir, entry.name, "SKILL.md"), "utf8");
      names.add(entry.name.slice(SKILL_PREFIX.length));
      const provenance = WIKITOM_PROVENANCE.exec(skill);
      if (provenance !== null) commits.add(provenance[1]);
    } catch {
      // A directory without a readable SKILL.md is not a body this hook can
      // grant, so it stays out of the catalog.
    }
  }
  return { names, commit: commits.size === 1 ? [...commits][0] : null };
}

// ── The hook ─────────────────────────────────────────────────────────────────

function main() {
  let payload = null;
  try {
    const input = readFileSync(0, "utf8");
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch {
    // The context hook has no event-specific output requirement.
  }

  // The box's nightly publishes its skill bodies and posts their commit as one
  // operation. Pulling here would advance only the checkout, then mislabel the
  // existing bodies; the laptop has no nightly, so it still refreshes first.
  if (process.env.RUN_HOST !== "box") pullWikiTom(wikitom);

  // A session that cannot write a directory still starts. The whole cost of
  // that failure is the one line below, which says the catalog may be older
  // than WikiTom and names the reason.
  let stale;
  let destinations = [];
  try {
    destinations = skillsDestinations();
    // ONE PUBLISHER PER HOST. On the box the nightly post step writes all three
    // account directories from WikiTom at the commit it also posts to Convex
    // (worker/jobs/nightly.mjs BOX_SKILLS_DIRS), and worker/setup.sh makes the
    // directories empty for that reason. A hook that published too would be a
    // second writer of the same files, and a mid-day pull would leave the box's
    // bodies at a commit Convex's catalog does not name. So on the box the hook
    // READS the directories and writes none of them; the laptop has no nightly,
    // so there this hook is the publisher.
    const failed = (process.env.RUN_HOST === "box" ? [] : refreshSkills({ dirs: destinations }))
      .filter((result) => !result.ok);
    if (failed.length > 0) {
      stale = `skill catalog may be stale: ${failed.map((result) => `${result.dir} — ${result.why}`).join("; ")}`;
    }
  } catch (error) {
    stale = `skill catalog may be stale: ${oneLine(error)}`;
  }

  let additionalContext;
  try {
    const prelude = assemblePrelude({ wikitom, layers: "operate" });
    let grants;
    let routed;
    try {
      // `subject: { kind: "none" }` because the hook has no `--for` argument to
      // take one from: a session start knows its caller and its cwd and nothing
      // about what the session is for. For the `laptop` caller that leaves one
      // row of the routing table standing — WRITE GOES WHEN THE RUN'S OUTPUT
      // REACHES TOM — so the grant is `write`, and the know layer is a `tts
      // search skills` away rather than a prompt away.
      const catalog = publishedCatalog(destinations[0]);
      routed = routeSkills({
        subject: { kind: "none" },
        caller: "laptop",
        pages: [],
        record: {},
        cwd: process.cwd(),
        repoDirs: skillRepoDirs(),
        published: catalog.names,
      });
      // An empty directory has no body to mislabel, so its current checkout is
      // a useful commit for the all-refused block. Any nonempty unprovenanced
      // or mixed directory says unknown rather than borrowing a just-pulled
      // checkout commit for bodies it did not read.
      const commit = catalog.commit ?? (catalog.names.size === 0 ? prelude.commit : "unknown");
      grants = renderGrants({ commit, granted: routed.granted, refused: routed.refused });
    } catch (error) {
      grants = `SKILLS could not be routed: ${oneLine(error)}`;
    }
    if (routed !== undefined) recordGrantReceipt(payload, routed);
    additionalContext = `${prelude.text}\n\n${grants}`;
  } catch (error) {
    additionalContext = `model-of-tom context could not be loaded: ${oneLine(error)}`;
  }

  if (stale !== undefined) additionalContext = `${additionalContext}\n${stale}`;

  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  })}\n`);
}

// Run as a hook, never on import: the test imports this file to check the pull
// (instructions-loaded-hook.mjs guards itself the same way, for the same
// reason), and scripts/laptop-setup.mjs imports refreshSkills from it so the
// one-time install and every session start publish the same set to the same two
// places. Every caller — laptop-setup.mjs and the box — names the interpreter.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
