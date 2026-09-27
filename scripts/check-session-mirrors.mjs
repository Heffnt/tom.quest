// Guardrail: the session vocabulary that the record and the site read has ONE
// home each, and this check fails on a second one. The repo map, the model
// table, the narrow list, the legacy model word, the staleness window and the
// usage-cap regex live in shared/session-constants.mjs, which every side
// imports (ledger graduation session-constants-two-homes). What remains here
// are two facts about tom.quest's own files with no importable home: the
// live-status list against the schema union, and the repo list pasted into
// code. The daemon's checks (a runner per model family, the compatibility
// links, the simplify job's inventory) left with the box's code for the
// Jarvis repository.
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { SESSION_REPOS } from "../shared/session-constants.mjs";

const shared = readFileSync("convex/ttsShared.ts", "utf8");

const failures = [];

// 1. The live-status list: LIVE_STATUSES has ONE home (ttsShared.ts) and its
// other half is the schema — "live" is defined as the claudeSessions.status
// union minus the two terminal statuses, so adding a status to the schema
// without deciding whether it is live fails here instead of silently being
// treated as finished. The second half of the fence is a no-second-home check:
// app/agents/lib.ts and convex/claudeSessions.ts each carried their own copy
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

// 2. No second copy of the repo list. SESSION_REPOS is the one home; before
// PR #28 the same fact was hand-written three more times (AUTO_REPOS,
// PROSPECT_REPOS, REPO_OPTIONS), so adding a repo in one place left the others
// silently disagreeing. Those three are gone — two are now DERIVED from the one
// home and one was deleted — and so are the daemon's and the launcher's hand copies,
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
  "app/jarvis/explanations.ts",
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
      // A link is the file it names, which the walk reads at its own path;
      // reading it here too would report it twice.
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

if (failures.length > 0) {
  console.error("Session-mirror check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("Session mirror check passed.");
