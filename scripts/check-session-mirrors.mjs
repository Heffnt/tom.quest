// Guardrail: the session vocabulary that the record, the site and the box all
// read has ONE home each, and this check fails on a second one. The repo map,
// the model table, the narrow list, the legacy model word, the staleness window
// and the usage-cap regex live in shared/session-constants.mjs, which every
// side imports (ledger graduation session-constants-two-homes); what remains
// here are the facts with no importable home: the model families' runners, the
// schema union, the symlinks that reach shared/ from worker/, the repo list
// pasted into code, and the simplify job's inventory.
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { SESSION_MODELS, SESSION_REPOS } from "../shared/session-constants.mjs";

const shared = readFileSync("convex/ttsShared.ts", "utf8");

const failures = [];

// 1. Every model family must have a runner branch in session.mjs startQuery:
// "claude" is the SDK query and "codex" the codexQuery import. A third family
// with no branch would silently run as Claude.
// witness: add a model with family "gemini" to SESSION_MODELS.
for (const family of new Set(Object.values(SESSION_MODELS).map((model) => model.family))) {
  if (family !== "claude" && family !== "codex") {
    failures.push(`SESSION_MODELS names family "${family}" but session.mjs has no runner for it`);
  }
}

// 2. The live-status list: LIVE_STATUSES has ONE home (ttsShared.ts) and its
// other half is the schema — "live" is defined as the claudeSessions.status
// union minus the two terminal statuses, so adding a status to the schema
// without deciding whether it is live fails here instead of silently being
// treated as finished. The second half of the fence is a no-second-home check:
// app/runs/lib.ts and convex/claudeSessions.ts each carried their own copy
// (with a comment claiming this file was the home), so the check refuses any
// re-declaration outside ttsShared.ts.
// witness: paste `const LIVE_STATUSES = [...]` back into claudeSessions.ts, or
// write `const isLive = (s) => ...` in any app/ or convex/ file, or add a
// status to the schema union without listing it here or as terminal.
const TERMINAL_STATUSES = ["ended", "failed"];
const liveBlock = shared.match(/export const LIVE_STATUSES = \[([^\]]+)\]/);
const schemaTs = readFileSync("convex/schema.ts", "utf8");
const sessionsTable = schemaTs.match(
  /claudeSessions: defineTable\(\{[\s\S]*?\n {4}status: v\.union\(([\s\S]*?)\n {4}\),/,
);
if (!liveBlock) failures.push("ttsShared.ts: LIVE_STATUSES literal not found");
if (!sessionsTable) {
  failures.push("schema.ts: claudeSessions status union not found");
}
if (liveBlock && sessionsTable) {
  const live = [...liveBlock[1].matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
  const schemaStatuses = [
    ...sessionsTable[1].matchAll(/v\.literal\("([\w-]+)"\)/g),
  ].map((m) => m[1]);
  const claimed = [...live, ...TERMINAL_STATUSES].sort().join("|");
  const declared = [...schemaStatuses].sort().join("|");
  if (claimed !== declared) {
    failures.push(
      `live-status list drifted from the schema union:\n  LIVE_STATUSES + terminal: ${claimed}\n  schema.ts claudeSessions:  ${declared}`,
    );
  }
}
// Every .ts/.tsx under app/ and convex/ is scanned, not just the two files
// that held the old copies: a third home is exactly as bad, and the three
// current isLive consumers (session-list, composer, session-view) are where
// one would plausibly land. Tests are skipped — a test may legitimately stub
// either name. Both the `function isLive(` and the `const isLive =` spellings
// count; matching only the first let an arrow-function copy through.
const declaresOwn = (text) => {
  const found = [];
  if (/(?:const|let|var)\s+LIVE_STATUSES\s*[:=]/.test(text)) {
    found.push("LIVE_STATUSES");
  }
  if (/(?:function\s+isLive\s*\(|(?:const|let|var)\s+isLive\s*[:=])/.test(text)) {
    found.push("isLive");
  }
  return found;
};

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "_generated") continue;
      if (entry.name === "__tests__") continue;
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

for (const file of [...walk("app"), ...walk("convex")]) {
  if (file === "convex/ttsShared.ts") continue; // the one home
  for (const name of declaresOwn(readFileSync(file, "utf8"))) {
    failures.push(
      `${file}: declares its own ${name} — the one home is convex/ttsShared.ts`,
    );
  }
}

// 3. Every compatibility link has ONE body. setup.sh installs jobs/ flat to
// /opt/tts and session-host/ to /opt/tts/session-host, so a spelled-out
// ../jobs or ../../shared import that resolves in the repo dangles on the box.
// Instead a module that lives elsewhere is reached through a symlink at the
// path its importers already use, and setup.sh's `cp` follows the link, so the
// box gets a real file at every home. worker/jobs/worker-env.mjs (the one
// env-file reader) and the modules shared/ holds are reached this way. Two
// ways to lose the one body: replace a link with a second real file, or point
// it somewhere else. Both are checked. The worker-env parse loop pasted back
// into a caller is the third, checked after the table.
// witness: `rm worker/session-host/worker-env.mjs && cp worker/jobs/worker-env.mjs
// worker/session-host/`, or copy the parse loop into lib.mjs.
const COMPAT_LINKS = [
  ["worker/session-host/worker-env.mjs", "../jobs/worker-env.mjs"],
  ["worker/session-host/session-archive.mjs", "../jobs/session-archive.mjs"],
  ["worker/session-host/redact.mjs", "../../shared/redact.mjs"],
  ["worker/jobs/clip.mjs", "../../shared/clip.mjs"],
  ["worker/jobs/evals-row.mjs", "../../shared/evals-row.mjs"],
  ["worker/jobs/graph-hash.mjs", "../../shared/graph-hash.mjs"],
  ["worker/jobs/graph.mjs", "../../shared/graph.mjs"],
  ["worker/jobs/learning-change-names.mjs", "../../shared/learning-change-names.mjs"],
  ["worker/jobs/markdown-sections.mjs", "../../shared/markdown-sections.mjs"],
  ["worker/session-host/session-constants.mjs", "../../shared/session-constants.mjs"],
];
// A checkout without symlink support (Windows without the privilege, or
// core.symlinks=false) writes a link as a one-line text file holding the
// target. That is git's own representation of the same link and it is what
// ships, so the target is what is checked, not the inode kind — the rule this
// enforces is "one body", and a file whose whole content is the target has no
// second body in it.
const linkTarget = (link) => {
  const stat = lstatSync(link);
  if (stat.isSymbolicLink()) return readlinkSync(link);
  const text = readFileSync(link, "utf8");
  const oneLine = text.trim();
  return oneLine === "" || /\s/.test(oneLine) ? null : oneLine;
};
for (const [link, expected] of COMPAT_LINKS) {
  try {
    const target = linkTarget(link);
    if (target === null) {
      failures.push(`${link} is a real file — it must stay a symlink to ${expected}`);
    } else if (target !== expected) {
      failures.push(`${link} points at ${target}, not ${expected}`);
    }
  } catch {
    failures.push(`${link} is missing — the box code that imports it by this path cannot load`);
  }
}
// The parse loop's own marker line, which must appear in exactly one file.
const PARSE_MARKER = 'const eq = line.indexOf("=");';
for (const [file, text] of [
  ["worker/jobs/tts-lib.mjs", readFileSync("worker/jobs/tts-lib.mjs", "utf8")],
  ["worker/session-host/lib.mjs", readFileSync("worker/session-host/lib.mjs", "utf8")],
]) {
  if (text.includes(PARSE_MARKER)) {
    failures.push(`${file} parses worker.env itself again — import loadEnv from worker-env.mjs`);
  }
}

// 4. No second copy of the repo list. SESSION_REPOS is the one home; before
// PR #28 the same fact was hand-written three more times (AUTO_REPOS,
// PROSPECT_REPOS, REPO_OPTIONS), so adding a repo in one place left the others
// silently disagreeing. Those three are gone — two are now DERIVED from the one
// home and one was deleted — and so are the daemon's and box-run's hand copies,
// which import shared/session-constants.mjs now. This check is what stops
// another appearing.
// Rule: outside the files listed in REPO_LIST_ALLOWED, no source file may name
// two or more session repos close together in executable code. Two names within
// REPO_NAME_WINDOW characters of each other is a list, whatever syntax carries
// it — an array, an object, a union type, a switch.
// Comments are stripped first on purpose: prose that names several repos is
// documentation and cannot drift into behavior (convex/schema.ts documents the
// mirror's repo column that way). Test files (*.test.* and *.spec.*) are exempt
// because a hard-coded expectation that goes red when the one home changes is
// the alarm working, not a silent copy.
// witness: paste `const REPOS = ["tom.quest", "WikiTom"]` into any convex/ or
// app/ file and this check fails.
const REPO_LIST_ALLOWED = new Set([
  "shared/session-constants.mjs", // the one home
  "scripts/check-session-mirrors.mjs", // this file
  // Prose, like a comment, but inside template literals the comment strip
  // cannot reach: this file is nothing but the HTML explanation documents
  // the ⓘ popover renders, and one of them names the three known repos
  // in a sentence. It carries no repo list that anything branches on.
  "app/tts/explanations.ts",
  // CHECKOUT PATHS, not the session repo list: where each repository's working
  // copy lives on the machine the code runs on. None of these can import a
  // Convex .ts, and the one home holds repo NAMES, which is a different fact
  // from a directory. session-start-hook.mjs and nightly.mjs joined the pair
  // when the skills landed: a `repo-<name>` skill is generated from a
  // checkout's AGENTS.md files, so both need name-to-directory, and the NAMES
  // they use are the ones the map's Repos block spells (model-of-tom/
  // agent-rules.md), which is a WikiTom fact rather than a Convex one.
  "scripts/laptop-setup.mjs",
  "scripts/instructions-loaded-hook.mjs",
  "scripts/session-start-hook.mjs",
  "worker/jobs/nightly.mjs",
  // The evals runner checks out the two trees ONE RUN reads — the pinned
  // tom.quest tree it scores and the pinned WikiTom tree it scores against.
  // That pair is a run's definition, not a list of repos sessions may work.
  "worker/jobs/evals.mjs",
  // THE TWO GENERATORS, for the same reason as evals.mjs and explanations.ts
  // together. Each takes the two checkouts it reads as parameters — `wikitom`
  // and `tomQuest` — and every hit in either file is one of two shapes: the
  // argument check that says which of the two is missing, or a PROVENANCE
  // STRING inside a template literal naming which checkout a disagreement's
  // two halves were read from ("WikiTom tts/spec.md §12.1" against
  // "tom.quest convex/ttsShared.ts"). A disagreement report that could not name
  // the checkout a row came from would not say where to go and fix it. Neither
  // file enumerates the repos a session may work: the list of other
  // repositories scripts/graph.mjs walks is handed in by its caller, which is
  // worker/jobs/nightly.mjs, already on this list and deriving it from the one
  // home. The comment strip cannot reach any of this because it is code.
  "scripts/graph.mjs",
  "scripts/vocabulary.mjs",
]);
const REPO_NAME_WINDOW = 300;
const SCAN_EXT = /\.(ts|tsx|mjs|cjs|js|jsx)$/;
const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vercel",
  "_generated",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
]);

const sourceFiles = [];
const walkSources = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) walkSources(join(dir, entry.name));
    } else if (entry.isSymbolicLink()) {
      // A compatibility link (check 3) is the file it names, which the walk
      // reads at its own path; reading it here too would report it twice.
      continue;
    } else if (
      SCAN_EXT.test(entry.name) &&
      !/\.(test|spec)\.[a-z]+$/.test(entry.name)
    ) {
      // POSIX separators, whatever the platform: REPO_LIST_ALLOWED is written
      // with "/" and a Windows join() answers a backslash, which made every
      // allowed file report — the one home, convex/ttsShared.ts, included.
      sourceFiles.push(join(dir, entry.name).split(sep).join("/").replace(/^\.\//, ""));
    }
  }
};

// Strip line and block comments so only executable code is searched. Kept
// deliberately simple: a `//` inside a string (a URL) is cut too, which can only
// shorten the searched text and therefore can only make this check quieter on a
// line that was already prose-heavy — never louder on a real list.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");

{
  const repoNames = Object.keys(SESSION_REPOS);
  if (repoNames.length < 2) {
    failures.push(
      "repo-list fence: fewer than 2 repo names parsed from SESSION_REPOS — the fence cannot run",
    );
  } else {
    const nameRes = repoNames.map((name) => ({
      name,
      re: new RegExp(`(?<![\\w.-])${name.replace(/\./g, "\\.")}(?![\\w-])`, "g"),
    }));
    walkSources(".");
    for (const file of sourceFiles) {
      if (REPO_LIST_ALLOWED.has(file)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      const hits = [];
      for (const { name, re } of nameRes) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(code)) !== null) hits.push({ name, at: m.index });
      }
      hits.sort((a, b) => a.at - b.at);
      for (let i = 0; i < hits.length - 1; i++) {
        const next = hits[i + 1];
        if (next.at - hits[i].at > REPO_NAME_WINDOW) continue;
        if (next.name === hits[i].name) continue;
        const line = code.slice(0, hits[i].at).split("\n").length;
        failures.push(
          `repo list copied outside the one home: ${file}:${line} names ${hits[i].name} and ${next.name} together — import SESSION_REPOS from shared/session-constants.mjs, or derive it from SESSION_REPO_NAMES in convex/ttsShared.ts, instead`,
        );
        break;
      }
    }
  }
}

// 5. Simplify runs from /opt/tts without the repository's package.json, so it
// cannot derive this deployed list. The scripts `pnpm check:guardrails` runs
// and STATIC_BOUNDARY_SCRIPTS in worker/jobs/simplify.mjs are one
// fact spelled twice. The simplify job reports the merge bar's contents from
// that list and cannot read the job's log, so a check missing from it is a
// check the weekly pass believes does not exist — a silent omission with no
// red anywhere. Found by the audit at f145d91, where a sixth check had just
// been added to package.json and the list still said five.
// witness: add a script to check:guardrails without naming it in simplify.mjs.
const guardrailsScript =
  JSON.parse(readFileSync("package.json", "utf8")).scripts?.["check:guardrails"] ?? "";
const ranScripts = [...guardrailsScript.matchAll(/scripts\/(check-[\w-]+)\.mjs/g)].map((m) => m[1]);
const simplifyMjs = readFileSync("worker/jobs/simplify.mjs", "utf8");
const inventoryBlock = simplifyMjs.match(/STATIC_BOUNDARY_SCRIPTS = \[([^\]]+)\]/);
if (ranScripts.length === 0) {
  failures.push("package.json: no scripts/check-*.mjs parsed out of check:guardrails — the fence cannot run");
}
if (!inventoryBlock) failures.push("simplify.mjs: STATIC_BOUNDARY_SCRIPTS not found");
if (ranScripts.length > 0 && inventoryBlock) {
  const listed = [...inventoryBlock[1].matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
  const a = [...ranScripts].sort().join("|");
  const b = [...listed].sort().join("|");
  if (a !== b) {
    failures.push(
      `the static-boundaries inventory drifted:\n  check:guardrails runs:     ${a}\n  simplify.mjs reports:      ${b}`,
    );
  }
}

if (failures.length > 0) {
  console.error("Session-mirror check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("Session mirror check passed.");
