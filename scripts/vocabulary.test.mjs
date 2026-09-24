import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AGENT_RULES_THRESHOLD_LF_BYTES,
  AUTHORITY,
  MAP_BLOCKS,
  PROMPT_TERMS,
  VOCABULARY_THRESHOLD_BYTES,
  formatDisagreement,
  generateVocabulary,
  main,
  parseBoxJobs,
  parseConvexJobs,
  parseEventKinds,
  parseTerms,
  renderMapCandidate,
  serialize,
  unifiedDiff,
  versionOf,
} from "./vocabulary.mjs";
import { promptDefinition, renderClosedVocabulary } from "./closed-vocabulary.mjs";

// ── Fixture ──────────────────────────────────────────────────────────────────
// Two whole checkouts in strings, written to a temp directory. Never the real
// repositories: a generator whose tests read the checkout it runs in passes or
// fails for reasons that have nothing to do with its parsers.
//
// Two files ARE copied from the real repository — worker/jobs/search-lib.mjs and
// shared/skills.mjs. The generator imports `SEARCH_COMMANDS` and `SKILL_SHAPES`
// from them and parses the same files as text, and that pair IS the check; a
// hand-written stand-in would assert the stand-in against itself.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SPEC = `# TTS

## 5. Data model

### 5.1 The three axes

Three axes.

### 5.4 Batches and needs

Batches hold nothing but their purpose.

## 7. Notification model

Six rooms.

## 12. The ground-up contract

### 12.1 Fixed vocabulary (canonical glossary)

Tom's ruling: TTS has a fixed vocabulary.

- **TTS** — Toms Todo System.
- **todo** — anything TTS tracks. Every todo is one of two kinds: a **task** (work an agent or Tom performs) or a **goal** (a checkable condition about the world).
- **batch** — a set of todos that share one purpose (§5.4).
- **needs** — the ids a todo depends on (§5.4).
- **ready** — every id in \`needs\` done (§5.4).
- **readiness** — \`unprepared\` / \`prepared\` (§5.1).
- **display text** — the always-visible register.
- **ground-up explanation** — the register behind a more link.
- **run** — one CLI or SDK thread (§23.1).
- **session** — a run Tom talks to (§20).
- **skill** — a loadable page.
- **\`#dump\` / \`#tts-today\`** — the two Slack channels (§7).
- **ground-up contract** (§12) · **task-shape contract** (§13).

**Words that are not TTS words.** **report and object** (observe and object) · **item** (a todo is a todo) · **path**, **must** (\`needs\` between batches).

## 20. The session surface

### 20.1 Vocabulary (fixed, extending §12.1)

- **mode** — the run's posture: \`interactive\` / \`autonomous\`.
- **reopen** — an ended session continues.

## 13. The task-shape contract

Bounded, near, interactive.

## 23. The unified agent ecosystem

### 23.1 Vocabulary (fixed, extending §12.1)

- **origin** — what started a run.
- **registration envelope** — what the launcher wrote down at launch.
- **file version** — one immutable snapshot of a run file.
`;

/**
 * SYNTHETIC, AND DELIBERATELY SO. The heading forms and bullet shapes are the
 * ones parseRepoBullets and the map-candidate renderer key on, and the three
 * repository NAMES are public facts this repository states everywhere. Every
 * word of prose after them is invented: nothing from
 * model-of-tom/agent-rules.md may enter this public repository, and the Never
 * list has no carve-out for a line that happens to read as generic. An earlier
 * fixture copied and truncated real lines, which is how they got here.
 */
const AGENT_RULES = `# Agent rules

You answer to Tom.

## Map

### Skills
- base: the page you are reading now.

### Repos
- tom.quest: the public site and the work it schedules.
- WikiTom: the private notes tree.
- ComplexMultiTrigger (CMT): the experiment harness.

### TTS
- the three row kinds the record holds.

### Search
- \`tts search\` (two corpora): answers without a model, on either machine.
- Pending rule suggestions: run the proposals query for one repo.

### Jobs
- Box (New York): the overnight pass at 04:00.
- The morning line: one run composes it.
- In Convex: the repeat minter at 04:30.

### Tools
- Box: the one search binary.

### Never
- Guess at a fact nobody wrote down.
`;

/** The prompt constant as the fixture's spec renders it: the opening line, then
 *  the seven §12.1 definitions through scripts/closed-vocabulary.mjs. */
const RENDERED_VOCABULARY = `The vocabulary, which is closed — each word means this and no more:
- batch — a set of todos that share one purpose.
- task — work an agent or Tom performs
- goal — a checkable condition about the world
- needs — the ids a todo depends on.
- ready — every id in needs done.
- display text — the always-visible register.
- ground-up explanation — the register behind a more link.`;

/** The same constant in wording of its own — the shape the real repositories
 *  had before Tom's ruling of 2026-09-24, when it was a second statement. */
const OWN_WORDING_VOCABULARY = `The vocabulary, which is closed — each word means this and no more:
- A BATCH holds how a set of todos gets completed.
- A TASK is work someone does. A GOAL is a state of the world.
- NEEDS are the todos a todo cannot proceed without. A todo is READY when every one of its needs is done.
- DISPLAY TEXT is the short line. A GROUND-UP EXPLANATION is the layer behind it.`;

function sharedTs(vocabularyBody = RENDERED_VOCABULARY) {
  return `import { v } from "convex/values";

export function commitKey(repo, sha) { return \`\${repo}@\${sha}\`; }
export function mergeKey(repo, sha) { return \`\${repo}:\${sha}\`; }

/** The closed TTS vocabulary. */
export const TTS_CLOSED_VOCABULARY = \`${vocabularyBody}\`;

export type SlackChannelKind = "today" | "decisions" | "needsYou" | "hourly" | "broken";

const CHANNEL_ENV: Record<SlackChannelKind, string> = {
  today: "SLACK_TTS_TODAY_CHANNEL_ID",
  decisions: "SLACK_TTS_DECISIONS_CHANNEL_ID",
  needsYou: "SLACK_TTS_NEEDS_YOU_CHANNEL_ID",
  hourly: "SLACK_TTS_HOURLY_CHANNEL_ID",
  broken: "SLACK_TTS_BROKEN_CHANNEL_ID",
};
`;
}

/** shared/session-constants.mjs, the one home of the repo map and the narrow
 *  list, in the shape the generator reads it. */
function sessionConstants() {
  return `export const NARROW_LIST = /** @type {const} */ ([]);

export const SESSION_REPOS = /** @type {const} */ ({
  "tom.quest": "Heffnt/tom.quest",
  ComplexMultiTrigger: "Heffnt/ComplexMultiTrigger",
  WikiTom: "Heffnt/WikiTom",
});

export const NO_REPO = "none";
`;
}

const EVENT_KINDS = [
  "slack-sent",
  "slack-event",
  "needs-tom",
  "slack-thread-claimed",
  "slack-claimed",
  "job-failed",
  "job-recovered",
  "delegate-decision",
  "delegate-objection",
  "evals-request",
  "evals-run",
  "tests-run",
  "audit-verdict",
  "merge",
  "deploy",
];

function schemaTs(kinds = EVENT_KINDS, declaredWord = "fifteen") {
  const rows = kinds.map((kind) => `    //   "${kind}"  — a row.`).join("\n");
  return `import { defineSchema, defineTable } from "convex/server";

export default defineSchema({
  dtsTodos: defineTable({ statement: v.string() }),
  dtsRulings: defineTable({ verdict: v.string() }),
  dtsBlocks: defineTable({ at: v.number() }),
  dtsTimeNotes: defineTable({ text: v.string() }),
  ttsRepeats: defineTable({ statement: v.string() }),
  ttsCalendarEvents: defineTable({ at: v.number() }),
  claudeSessions: defineTable({ sdkSessionId: v.optional(v.string()) }),
  runs: defineTable({ regToken: v.optional(v.string()) }),
  runFileVersions: defineTable({ hash: v.string() }),
  dtsEvents: defineTable({
    at: v.number(),
    // The lookup key, set on exactly ${declaredWord} kinds:
${rows}
    key: v.optional(v.string()),
  }),
});
`;
}

const CRONS_TS = `import { cronJobs } from "convex/server";
const crons = cronJobs();

crons.interval("poll turing health", { seconds: 30 }, internal.serverHealth.pollTuring);
crons.cron("tts repeats (edt)", "30 8 * * *", internal.ttsRepeats.internalGenerateRepeats, {});
crons.cron("tts repeats (est)", "30 9 * * *", internal.ttsRepeats.internalGenerateRepeats, {});
crons.interval("tts hourly update", { hours: 1 }, internal.ttsSync.sendHourlyUpdate, {});

export default crons;
`;

const SETUP_SH = `#!/bin/sh
cat > /etc/cron.d/tts <<'CRON'
SHELL=/bin/sh

# Poll the dump channel hourly.
7 * * * * root /usr/bin/node /opt/tts/poll-dump.mjs >> /var/log/tts/poll-dump.log 2>&1

# The nightly job at 4 a.m. New York.
0 8 * * * root /usr/bin/flock -n /var/lock/tts-nightly.lock /usr/bin/node /opt/tts/nightly.mjs >> /var/log/tts/nightly.log 2>&1
0 9 * * * root /usr/bin/flock -n /var/lock/tts-nightly.lock /usr/bin/node /opt/tts/nightly.mjs >> /var/log/tts/nightly.log 2>&1

# Log hygiene: truncate the TTS logs on the 1st of each month.
0 6 1 * * root sh -c 'for f in /var/log/tts/*.log; do : > "$f"; done'
CRON
`;

const FILES = Object.freeze({
  "convex/runs.ts": 'const RUN_ID = /^(claude|codex):(laptop|box):[A-Za-z0-9._-]{8,128}(\\/[A-Za-z0-9._-]{8,128})?$/;\n',
  "convex/http.ts": 'if (!/^[0-9a-f]{8}$/.test(b.askId)) return bad();\n',
  // Both keys live in ttsShared.ts, which convex/ttsEvals.ts already imports;
  // ttsMerge.ts re-exports them, so it is not where they are minted.
  "convex/ttsMerge.ts": 'export { commitKey, mergeKey } from "./ttsShared";\n',
  "convex/ttsEvals.ts": 'export const EVALS_RUN = "evals-run";\n',
  "worker/runs/ingest.mjs": "const rootId = `claude:${host}:${sessionId}`;\n",
  "worker/runs/registration.mjs":
    "const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;\nconst token = crypto.randomUUID();\n",
  "worker/runs/store.mjs": "const objectKey = ({ runtime, host }) => [runtime, host].join('/');\n",
  "worker/session-host/session.mjs": "this.sdkSessionId = undefined;\n",
  "worker/jobs/nightly.mjs": 'const kinds = ["job-failed", "job-recovered"];\n',
  "worker/jobs/poll-dump.mjs": 'const kinds = ["slack-event"];\n',
  "worker/bin/tts-search": "#!/bin/sh\n",
  "worker/bin/tts-audit": "#!/bin/sh\n",
});

const AREAS = ["admin", "research"];

function write(root, rel, body) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

/** A WikiTom and a tom.quest, both minimal, both complete enough to generate. */
function makeCheckouts(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocabulary-"));
  const wikitom = path.join(root, "wikitom");
  const tomQuest = path.join(root, "tom.quest");
  write(wikitom, "tts/spec.md", overrides.spec ?? SPEC);
  write(wikitom, "model-of-tom/agent-rules.md", overrides.agentRules ?? AGENT_RULES);
  write(wikitom, "model-of-tom/evidence/agent-rules.md", "# agent-rules.md\n\n## Repos\n\n- line: x\n  read: 2026-09-11 · tom.quest\n");
  for (const area of AREAS) write(wikitom, `model-of-tom/areas/${area}.md`, `---\ncategories: [${area}]\n---\n\n## Current state\n`);
  write(tomQuest, "convex/schema.ts", overrides.schema ?? schemaTs());
  write(tomQuest, "convex/ttsShared.ts", overrides.shared ?? sharedTs());
  if (overrides.sessionConstants !== null) {
    write(tomQuest, "shared/session-constants.mjs", overrides.sessionConstants ?? sessionConstants());
  }
  write(tomQuest, "convex/crons.ts", overrides.crons ?? CRONS_TS);
  write(tomQuest, "worker/setup.sh", overrides.setup ?? SETUP_SH);
  for (const [rel, body] of Object.entries(FILES)) write(tomQuest, rel, overrides[rel] ?? body);
  // The two files the generator both imports and parses. An override stands in
  // for a tom.quest checkout that is NOT the one this generator was installed
  // from, which is the case on the box and the case the shapes read below is
  // about.
  for (const rel of ["worker/jobs/search-lib.mjs", "shared/skills.mjs"]) {
    write(tomQuest, rel, overrides[rel] ?? fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
  }
  return { root, wikitom, tomQuest };
}

function run(checkouts, options = {}) {
  return generateVocabulary({ wikitom: checkouts.wikitom, tomQuest: checkouts.tomQuest, ...options });
}

function codes(result) {
  return result.disagreements.map((entry) => entry.code).sort();
}

/**
 * The module with one constant edited, imported from a temp directory. The two
 * switches are module constants on purpose (no environment override, so the box
 * and the laptop cannot generate different files), which leaves rewriting the
 * line as the only way to exercise the other side of one.
 */
async function withConstant(line, replacement) {
  const source = fs
    .readFileSync(path.join(REPO_ROOT, "scripts/vocabulary.mjs"), "utf8")
    .replace(line, replacement)
    .replace(/from "\.\.\/((?:worker|shared)\/[^"]+)"/g, (_, rel) => `from "${pathToFileURL(path.join(REPO_ROOT, rel)).href}"`)
    // EVERY scripts/ SIBLING: the variant is written into node_modules/, where a
    // relative `./x.mjs` resolves to nothing. graph.mjs joined here when the
    // HEAD parser moved into it, and closed-vocabulary.mjs when the prompt's
    // block started rendering from it; skills.mjs moved to shared/, which the
    // line above rewrites.
    .replace(/from "\.\/(graph\.mjs|closed-vocabulary\.mjs)"/g, (_, rel) => `from "${pathToFileURL(path.join(REPO_ROOT, "scripts", rel)).href}"`);
  // Inside the project root: the test runner resolves a dynamic import only
  // under the root it was started in.
  const root = path.join(REPO_ROOT, "node_modules", ".vocabulary-variants");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "v-"));
  const file = path.join(dir, "vocabulary.mjs");
  fs.writeFileSync(file, source, "utf8");
  return import(pathToFileURL(file).href);
}

// ── The switches ─────────────────────────────────────────────────────────────

describe("the switches", () => {
  it("ships the defaults", () => {
    expect(MAP_BLOCKS).toBe("candidate");
    expect(AUTHORITY).toBe("spec");
    expect(VOCABULARY_THRESHOLD_BYTES).toBe(40_960);
    expect(AGENT_RULES_THRESHOLD_LF_BYTES).toBe(7_000);
  });

  it("refuses an AUTHORITY it has not built, naming the missing work", async () => {
    const variant = await withConstant('export const AUTHORITY = "spec";', 'export const AUTHORITY = "file";');
    const checkouts = makeCheckouts();
    expect(() => variant.generateVocabulary({ wikitom: checkouts.wikitom, tomQuest: checkouts.tomQuest })).toThrow(
      'vocabulary: AUTHORITY "file" is not built — the spec-renders-from-the-file direction needs a writer for tts/spec.md §12.1 and a tom-gate on it; see phase 10 switch (b)',
    );
  });
});

// ── The spec ─────────────────────────────────────────────────────────────────

describe("§12.1 and its extensions", () => {
  it("reads a bolded word, its definition and its cross-reference", () => {
    const terms = parseTerms(SPEC);
    const batch = terms.find((term) => term.term === "batch");
    expect(batch.definition).toBe("a set of todos that share one purpose (§5.4).");
    expect(batch.specSection).toBe("5.4");
    const tts = terms.find((term) => term.term === "TTS");
    expect(tts.specSection).toBe("12.1");
  });

  it("reads a word glossed inside another word's definition", () => {
    const terms = parseTerms(SPEC);
    expect(terms.find((term) => term.term === "task").definition).toBe("work an agent or Tom performs");
    expect(terms.find((term) => term.term === "goal").definition).toBe("a checkable condition about the world");
  });

  it("reads a definition whose cross-reference sits mid-sentence", () => {
    const terms = parseTerms(SPEC);
    expect(terms.find((term) => term.term === "ready").specSection).toBe("5.4");
    expect(terms.find((term) => term.term === "ready").definition).toContain("every id in `needs` done");
  });

  it("reads a bold holding several names as one definition over each", () => {
    const terms = parseTerms(SPEC);
    expect(terms.find((term) => term.term === "#dump").kind).toBe("channel");
    expect(terms.find((term) => term.term === "#tts-today").definition).toBe("the two Slack channels (§7).");
  });

  it("reads the cross-reference bullet as one contract each", () => {
    const terms = parseTerms(SPEC);
    expect(terms.find((term) => term.term === "task-shape contract")).toMatchObject({
      kind: "contract",
      definition: "fixed in §13",
      specSection: "13",
    });
  });

  it("reads the refusal line into refused terms carrying what they are a second name for", () => {
    const terms = parseTerms(SPEC);
    const refused = terms.filter((term) => term.kind === "refused").map((term) => term.term);
    expect(refused).toEqual(["report and object", "item", "path", "must"]);
    expect(terms.find((term) => term.term === "report and object").definition).toBe(
      "not a TTS word — observe and object",
    );
  });

  it("reads §20.1 and §23.1 as extensions under their own subsection", () => {
    const terms = parseTerms(SPEC);
    expect(terms.find((term) => term.term === "mode").specSection).toBe("20.1");
    expect(terms.find((term) => term.term === "origin").specSection).toBe("23.1");
  });

  it("fails on a section it cannot find rather than producing a short list", () => {
    expect(() => parseTerms(SPEC.replace("### 23.1 Vocabulary (fixed, extending §12.1)", "### 23.9 Something else"))).toThrow(
      /no `### 23.1` heading/,
    );
  });
});

// ── The event key register ───────────────────────────────────────────────────

describe("the dtsEvents.key register", () => {
  it("reads one kind per spelling the comment names", () => {
    expect(parseEventKinds(schemaTs())).toEqual([...EVENT_KINDS].sort((a, b) => a.localeCompare(b)));
  });

  it("fails when the comment says fifteen and fewer than fifteen parse", () => {
    expect(() => parseEventKinds(schemaTs(EVENT_KINDS.slice(0, 14)))).toThrow(
      /dtsEvents\.key: the source declares 15 and the parser read 14/,
    );
  });

  // The deploy job in Heffnt/Jarvis posts "deploy" rows keyed `<repo>:<sha>`.
  // The real schema must register it, and a spelling must claim it, or the
  // generator stops on the comment the job's rows are described by.
  it("registers the deploy kind in the real schema, and a spelling claims it", () => {
    const kinds = parseEventKinds(fs.readFileSync(path.join(REPO_ROOT, "convex/schema.ts"), "utf8"));
    expect(kinds).toContain("deploy");
    expect(kinds).toContain("merge");
    expect(() => run(makeCheckouts({ schema: schemaTs(EVENT_KINDS.filter((kind) => kind !== "deploy"), "fourteen") }))).toThrow(
      /spellings/,
    );
  });
});

// ── The jobs ─────────────────────────────────────────────────────────────────

describe("the jobs", () => {
  it("reads crons.interval and crons.cron", () => {
    const jobs = parseConvexJobs(CRONS_TS);
    expect(jobs.map((job) => job.name).sort()).toEqual([
      "poll turing health",
      "tts hourly update",
      "tts repeats (edt)",
      "tts repeats (est)",
    ]);
    expect(jobs.find((job) => job.name === "poll turing health").cadence).toBe("every 30 seconds");
    expect(jobs.find((job) => job.name === "tts repeats (edt)").cronLines).toEqual(["30 8 * * *"]);
  });

  it("fails on a crons call it cannot read rather than dropping the job", () => {
    expect(() => parseConvexJobs(`${CRONS_TS}\ncrons.monthly("tts audit", whatever);\n`)).toThrow(
      /crons\.ts: the source declares 5 and the parser read 4/,
    );
  });

  it("reads the setup.sh heredoc, and names a shell line from its own comment", () => {
    const jobs = parseBoxJobs(SETUP_SH);
    expect(jobs.map((job) => job.name)).toEqual(["poll-dump", "nightly", "nightly", "log-hygiene"]);
    expect(jobs[1].file).toBe("worker/jobs/nightly.mjs");
    expect(jobs[3].file).toBeNull();
  });

  it("fails on a cron line it cannot read at all", () => {
    const broken = SETUP_SH.replace(
      "# Log hygiene: truncate the TTS logs on the 1st of each month.\n",
      "",
    );
    expect(() => parseBoxJobs(broken)).toThrow(/runs no \/opt\/tts script and its comment names no job/);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe("the serialization and the version", () => {
  it("is byte-identical across two runs on one input", () => {
    const checkouts = makeCheckouts();
    const first = run(checkouts);
    const second = run(checkouts);
    expect(second.serialized).toBe(first.serialized);
    expect(second.version).toBe(first.version);
  });

  it("is byte-identical across a CRLF and an LF checkout", () => {
    const lf = makeCheckouts();
    const crlf = makeCheckouts({
      spec: SPEC.replace(/\n/g, "\r\n"),
      agentRules: AGENT_RULES.replace(/\n/g, "\r\n"),
      shared: sharedTs().replace(/\n/g, "\r\n"),
    });
    expect(run(crlf).serialized).toBe(run(lf).serialized);
  });

  it("changes when one definition changes by one character", () => {
    const before = run(makeCheckouts());
    const after = run(makeCheckouts({ spec: SPEC.replace("share one purpose (§5.4)", "share one purposes (§5.4)") }));
    expect(after.version).not.toBe(before.version);
  });

  it("hashes over the serialization with its own version blanked", () => {
    const checkouts = makeCheckouts();
    const result = run(checkouts);
    expect(versionOf(result.vocabulary)).toBe(result.version);
    expect(result.version).toMatch(/^[0-9a-f]{16}$/);
    expect(serialize(result.vocabulary).endsWith("}\n")).toBe(true);
  });

  it("sorts every array by its first field", () => {
    const { vocabulary } = run(makeCheckouts());
    for (const [section, field] of [
      ["terms", "term"],
      ["entities", "id"],
      ["jobs", "name"],
      ["searchQuestions", "command"],
      ["skills", "name"],
      ["repos", "name"],
      ["channels", "name"],
    ]) {
      const values = vocabulary[section].map((row) => row[field]);
      expect(values).toEqual([...values].sort((a, b) => a.localeCompare(b)));
    }
  });
});

// ── The cap ──────────────────────────────────────────────────────────────────

describe("the size threshold", () => {
  it("warns over the threshold, naming the size, the threshold and the largest section, and writes anyway", async () => {
    const fat = SPEC.replace("- **TTS** — Toms Todo System.", `- **TTS** — ${"a".repeat(60_000)}`);
    const checkouts = makeCheckouts({ spec: fat });
    const result = run(checkouts, { write: "vocabulary" });
    expect(result.sizeWarning).toMatch(
      new RegExp(`the file is ${result.bytes} bytes, over the ${VOCABULARY_THRESHOLD_BYTES}-byte threshold; its largest section is terms at \\d+ bytes`),
    );
    expect(result.written).toEqual(["tts/vocabulary.json"]);
    expect(fs.existsSync(path.join(checkouts.wikitom, "tts/vocabulary.json"))).toBe(true);
    const lines = [];
    const code = await main(["--wikitom", checkouts.wikitom, "--tom-quest", checkouts.tomQuest], {
      write: (text) => lines.push(text),
      error: (text) => lines.push(text),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("over the 40960-byte threshold");
  });

  it("is silent under the threshold", () => {
    expect(run(makeCheckouts()).sizeWarning).toBeNull();
  });
});

// ── Who writes what ──────────────────────────────────────────────────────────

describe("the writers", () => {
  it("the nightly's write puts tts/vocabulary.json in WikiTom and touches no tom.quest file and no map file", () => {
    const checkouts = makeCheckouts();
    const shared = fs.readFileSync(path.join(checkouts.tomQuest, "convex/ttsShared.ts"), "utf8");
    const before = fs.readdirSync(path.join(checkouts.wikitom, "model-of-tom"), { recursive: true }).sort();
    const result = run(checkouts, { write: "vocabulary" });
    expect(result.changed).toContain("convex/ttsShared.ts");
    expect(result.written).toEqual(["tts/vocabulary.json"]);
    expect(fs.readFileSync(path.join(checkouts.wikitom, "tts/vocabulary.json"), "utf8")).toBe(result.serialized);
    expect(fs.readFileSync(path.join(checkouts.tomQuest, "convex/ttsShared.ts"), "utf8")).toBe(shared);
    expect(fs.readdirSync(path.join(checkouts.wikitom, "model-of-tom"), { recursive: true }).sort()).toEqual(before);
  });

  it("--write also lands the generated block in convex/ttsShared.ts", () => {
    const checkouts = makeCheckouts();
    const result = run(checkouts, { write: true });
    expect(result.written).toEqual(["tts/vocabulary.json", "convex/ttsShared.ts"]);
    expect(fs.readFileSync(path.join(checkouts.tomQuest, "convex/ttsShared.ts"), "utf8")).toBe(result.sharedAfter);
  });

  it("refuses a write target it does not know", () => {
    expect(() => run(makeCheckouts(), { write: "shared" })).toThrow('write is false, true or "vocabulary"');
  });
});

// ── The disagreements ────────────────────────────────────────────────────────

describe("the disagreement check", () => {
  it("finds nothing on a fixture whose two repositories agree", () => {
    expect(run(makeCheckouts()).disagreements).toEqual([]);
  });

  it("a constant in its own words is not a disagreement: the block re-renders it from the spec", () => {
    const checkouts = makeCheckouts({ shared: sharedTs(OWN_WORDING_VOCABULARY) });
    const result = run(checkouts);
    expect(result.disagreements).toEqual([]);
    expect(result.changed).toContain("convex/ttsShared.ts");
    expect(result.sharedBlock).toContain(`export const TTS_CLOSED_VOCABULARY = \`${RENDERED_VOCABULARY}\`;`);
    expect(result.sharedBlock).not.toContain("A BATCH holds how a set of todos gets completed.");
  });

  it("throws naming a prompt word §12.1 does not define", () => {
    const spec = SPEC.replace("- **display text** — the always-visible register.\n", "");
    expect(() => run(makeCheckouts({ spec }))).toThrow('PROMPT_TERMS names "display text", which §12.1 does not define');
  });

  it("D2 — a term's code symbol does not exist, in the printed shape", () => {
    const result = run(makeCheckouts({ schema: schemaTs().replace("runs: defineTable", "dtsRuns: defineTable") }));
    expect(codes(result)).toEqual(["D2"]);
    expect(result.disagreements[0].subject).toBe('term "run"');
    expect(result.disagreements[0].rows[1].text).toContain("`runs: defineTable`");
    const block = formatDisagreement(result.disagreements[0]).split("\n");
    expect(block[0]).toBe('DISAGREEMENT D2  term "run"');
    expect(block[1]).toBe("  spec  WikiTom tts/spec.md §23.1");
    expect(block[2]).toBe("        one CLI or SDK thread (§23.1).");
    expect(block[3]).toBe("  code  tom.quest convex/schema.ts");
    expect(block[5]).toMatch(/^ {2}fix {3}point the term at the symbol that exists/);
    expect(block).toHaveLength(6);
  });

  it("D3 — a term's spec section does not exist", () => {
    const result = run(makeCheckouts({ spec: SPEC.replace("### 5.4 Batches and needs", "### 5.5 Batches and needs") }));
    expect(codes(result).filter((code) => code === "D3")).toEqual(["D3", "D3", "D3"]);
    expect(result.disagreements.find((entry) => entry.code === "D3").rows[0].text).toBe("no heading of that number exists");
  });

  it("D4 — an entity is wrong about itself", () => {
    const result = run(makeCheckouts({ "worker/runs/store.mjs": "const somethingElse = () => null;\n" }));
    expect(codes(result)).toEqual(["D4"]);
    expect(result.disagreements[0].subject).toBe('entity "storeKey"');
  });

  it("D5 — two lists of one set", () => {
    const result = run(makeCheckouts({ sessionConstants: sessionConstants().replace('  WikiTom: "Heffnt/WikiTom",\n', "") }));
    expect(codes(result)).toEqual([]);
    const missing = run(makeCheckouts({ agentRules: AGENT_RULES.replace("- WikiTom: the private notes tree.\n", "") }));
    expect(codes(missing)).toEqual(["D5"]);
    expect(missing.disagreements[0].subject).toBe('repository "WikiTom"');
  });

  it("reads the repo map from convex/ttsShared.ts in a tom.quest checkout from before shared/ held it", () => {
    const older = sharedTs().replace(
      "export type SlackChannelKind",
      'export const SESSION_REPOS = {\n  "tom.quest": "Heffnt/tom.quest",\n  Extra: "Heffnt/Extra",\n} as const;\n\nexport type SlackChannelKind',
    );
    const result = run(makeCheckouts({ sessionConstants: null, shared: older }));
    expect(codes(result)).toContain("D5");
    const extra = result.disagreements.find((entry) => entry.subject === 'repository "Extra"');
    expect(extra.rows[1].where).toBe("tom.quest convex/ttsShared.ts SESSION_REPOS");
    expect(() => run(makeCheckouts({ sessionConstants: null }))).toThrow("has `SESSION_REPOS`");
  });

  it("D5 — a tom.quest older than this generator is a disagreement, not a throw", () => {
    // THE CASE THE BOX PRODUCES. worker/setup.sh installs these scripts from the
    // branch it is rolled from and nothing pulls /root/tom.quest, so the text
    // this generator parses is routinely a checkout behind the SKILL_SHAPES it
    // was written against. It was: from the night `explainer` landed in the
    // install and not in that checkout, a count asserted between the two threw
    // "the source declares 6 and the parser read 5" and the nightly's graph step
    // wrote no graph, every night.
    const older = fs
      .readFileSync(path.join(REPO_ROOT, "shared/skills.mjs"), "utf8")
      .replace(/ {2}explainer: Object\.freeze\(\{[\s\S]*?\n {2}\}\),\n/, "");
    expect(older).not.toContain("explainer: Object.freeze({");
    const result = run(makeCheckouts({ "shared/skills.mjs": older }));
    expect(codes(result)).toEqual(["D5"]);
    expect(result.disagreements[0].subject).toBe('skill "explainer"');
    expect(result.disagreements[0].rows[1].text).not.toContain("explainer");
  });

  it("collects every disagreement and never stops at the first", () => {
    const result = run(
      makeCheckouts({
        schema: schemaTs().replace("runs: defineTable", "dtsRuns: defineTable"),
        "worker/runs/store.mjs": "const somethingElse = () => null;\n",
      }),
    );
    expect(codes(result)).toEqual(["D2", "D4"]);
    expect(result.report).toContain("vocabulary: 2 disagreements — nothing written.");
  });

  it("exits 2 on a disagreement and writes nothing", async () => {
    const checkouts = makeCheckouts({ schema: schemaTs().replace("runs: defineTable", "dtsRuns: defineTable") });
    const lines = [];
    const code = await main(["--wikitom", checkouts.wikitom, "--tom-quest", checkouts.tomQuest, "--write"], {
      write: (text) => lines.push(text),
      error: (text) => lines.push(text),
    });
    expect(code).toBe(2);
    expect(fs.existsSync(path.join(checkouts.wikitom, "tts/vocabulary.json"))).toBe(false);
  });
});

// ── The map candidate ────────────────────────────────────────────────────────

describe("the map candidate", () => {
  it("writes no map file under MAP_BLOCKS = candidate, and returns the diff", () => {
    const checkouts = makeCheckouts();
    const before = fs.readFileSync(path.join(checkouts.wikitom, "model-of-tom/agent-rules.md"));
    const result = run(checkouts, { write: true });
    expect(result.disagreements).toEqual([]);
    expect(fs.readFileSync(path.join(checkouts.wikitom, "model-of-tom/agent-rules.md"))).toEqual(before);
    for (const rel of [
      "model-of-tom/agent-rules.candidate.md",
      "model-of-tom/agent-rules.candidate.diff",
      "model-of-tom/evidence/agent-rules.candidate.md",
    ]) {
      expect(fs.existsSync(path.join(checkouts.wikitom, rel))).toBe(false);
    }
    expect(result.mapDiffersFromRender).toBe(true);
    expect(result.mapCandidateDiff).toContain("--- a/model-of-tom/agent-rules.md");
  });

  it("keeps every line of the map it did not derive", () => {
    const rendered = renderMapCandidate(AGENT_RULES, {
      repos: ["- tom.quest: one line."],
      search: ["- `tts search` (x): read-only."],
      boxJobs: ["- Box (New York): nightly."],
      convexJobs: ["- In Convex: repeats."],
      tools: ["- Box: tts-search."],
    });
    expect(rendered.text).toContain("- The morning line: one run composes it.");
    expect(rendered.text).toContain("- Pending rule suggestions: run the proposals query for one repo.");
    expect(rendered.text).toContain("- Guess at a fact nobody wrote down.");
    expect(rendered.text).not.toContain("- WikiTom: the private notes tree.");
  });

  it("writes the four blocks in place under MAP_BLOCKS = live, and nothing else moves", async () => {
    const variant = await withConstant('export const MAP_BLOCKS = "candidate";', 'export const MAP_BLOCKS = "live";');
    const checkouts = makeCheckouts();
    variant.generateVocabulary({ wikitom: checkouts.wikitom, tomQuest: checkouts.tomQuest, write: true });
    const after = fs.readFileSync(path.join(checkouts.wikitom, "model-of-tom/agent-rules.md"), "utf8");
    expect(after).not.toBe(AGENT_RULES);
    expect(after).toContain("### Never\n- Guess at a fact nobody wrote down.");
    expect(after).toContain("- The morning line: one run composes it.");
    expect(fs.existsSync(path.join(checkouts.wikitom, "model-of-tom/agent-rules.candidate.md"))).toBe(false);
  });

  it("warns on a map over the threshold, naming its LF size and the threshold, and blocks nothing", async () => {
    const fat = AGENT_RULES.replace("You answer to Tom.", `You answer to Tom. ${"padding ".repeat(880)}`);
    const checkouts = makeCheckouts({ agentRules: fat });
    const result = run(checkouts, { write: true });
    expect(result.mapSizeWarning).toBe(
      `vocabulary: warning — the map, model-of-tom/agent-rules.md, is ${result.mapLfBytes} LF bytes, over the ${AGENT_RULES_THRESHOLD_LF_BYTES}-byte threshold. The threshold asks for dedicated effort on the map's size; it blocks nothing`,
    );
    expect(result.written).toEqual(["tts/vocabulary.json", "convex/ttsShared.ts"]);
    const lines = [];
    const code = await main(["--wikitom", checkouts.wikitom, "--tom-quest", checkouts.tomQuest], {
      write: (text) => lines.push(text),
      error: (text) => lines.push(text),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("over the 7000-byte threshold");
  });

  it("counts the map on LF bytes, not on its CRLF line endings", () => {
    const checkouts = makeCheckouts({ agentRules: AGENT_RULES.replace(/\n/g, "\r\n") });
    expect(run(checkouts).mapLfBytes).toBe(Buffer.byteLength(AGENT_RULES));
  });

  it("writes the live map over the threshold under MAP_BLOCKS = live, with the warning", async () => {
    const variant = await withConstant('export const MAP_BLOCKS = "candidate";', 'export const MAP_BLOCKS = "live";');
    const fat = AGENT_RULES.replace("You answer to Tom.", `You answer to Tom. ${"padding ".repeat(880)}`);
    const checkouts = makeCheckouts({ agentRules: fat });
    const lines = [];
    const code = await variant.main(["--wikitom", checkouts.wikitom, "--tom-quest", checkouts.tomQuest, "--write"], {
      write: (text) => lines.push(text),
      error: (text) => lines.push(text),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("over the 7000-byte threshold");
    expect(fs.readFileSync(path.join(checkouts.wikitom, "model-of-tom/agent-rules.md"), "utf8")).not.toBe(fat);
  });

  it("writes a unified diff with three lines of context", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i"].join("\n");
    const diff = unifiedDiff(before, after, "x.md", "x.candidate.md");
    expect(diff.split("\n").slice(0, 3)).toEqual(["--- a/x.md", "+++ b/x.candidate.md", "@@ -2,7 +2,7 @@"]);
    expect(diff).toContain("-e");
    expect(diff).toContain("+E");
    expect(unifiedDiff(before, before, "x.md", "x.candidate.md")).toBe("");
  });
});

// ── The generated block in convex/ttsShared.ts ───────────────────────────────

describe("the generated block", () => {
  it("carries the constant rendered from the spec, the version and the three lists", () => {
    const result = run(makeCheckouts());
    expect(result.sharedBlock).toContain(`// <vocabulary generated version=${result.version} — scripts/vocabulary.mjs; do not edit>`);
    expect(result.sharedBlock).toContain("// </vocabulary generated>");
    expect(result.sharedBlock).toContain(`export const TTS_CLOSED_VOCABULARY = \`${RENDERED_VOCABULARY}\`;`);
    expect(result.sharedBlock).toContain(`export const VOCABULARY_VERSION = "${result.version}";`);
    expect(result.sharedBlock).toContain("export const VOCABULARY_TERMS: readonly string[] = [");
    expect(result.sharedBlock).toContain("export const GRAPH_NODE_KINDS: readonly string[] = [");
    expect(result.sharedBlock).toContain("export const GRAPH_EDGE_KINDS: readonly string[] = [");
    // Names only: a definition in a bundled constant is a second copy of the file.
    expect(result.sharedBlock).not.toContain("a set of todos that share one purpose (§5.4)");
  });

  it("names every one of the seven the prompt carries", () => {
    const { vocabulary } = run(makeCheckouts());
    for (const name of PROMPT_TERMS) {
      expect(vocabulary.terms.some((term) => term.term === name)).toBe(true);
    }
  });

  it("re-running over its own output is a no-op", () => {
    const checkouts = makeCheckouts();
    const first = run(checkouts, { write: true });
    expect(first.changed).toContain("tts/vocabulary.json");
    expect(first.changed).toContain("convex/ttsShared.ts");
    const second = run(checkouts);
    expect(second.changed).toEqual([]);
    expect(second.written).toEqual([]);
    expect(second.version).toBe(first.version);
    const third = run(checkouts, { write: true });
    expect(third.version).toBe(first.version);
    expect(third.sharedAfter).toBe(fs.readFileSync(path.join(checkouts.tomQuest, "convex/ttsShared.ts"), "utf8"));
  });

  it("--check exits 2 when the disk is out of date and 0 when it is not", async () => {
    const checkouts = makeCheckouts();
    const stale = [];
    expect(
      await main(["--wikitom", checkouts.wikitom, "--tom-quest", checkouts.tomQuest, "--check"], {
        write: (text) => stale.push(text),
        error: (text) => stale.push(text),
      }),
    ).toBe(2);
    run(checkouts, { write: true });
    const fresh = [];
    expect(
      await main(["--wikitom", checkouts.wikitom, "--tom-quest", checkouts.tomQuest, "--check"], {
        write: (text) => fresh.push(text),
        error: (text) => fresh.push(text),
      }),
    ).toBe(0);
  });
});

// ── The command line ─────────────────────────────────────────────────────────

describe("the command line", () => {
  it("exits 3 on a missing checkout", async () => {
    const lines = [];
    const code = await main(["--wikitom", path.join(os.tmpdir(), "no-wikitom-here"), "--tom-quest", REPO_ROOT], {
      write: (text) => lines.push(text),
      error: (text) => lines.push(text),
    });
    expect(code).toBe(3);
    expect(lines.join("\n")).toContain("does not exist");
  });

  it("exits 3 on an option it does not know", async () => {
    const lines = [];
    expect(await main(["--nonsense"], { write: (t) => lines.push(t), error: (t) => lines.push(t) })).toBe(3);
    expect(lines.join("\n")).toContain("unknown option --nonsense");
  });

  it("prints the result object under --json and writes nothing without --write", async () => {
    const checkouts = makeCheckouts();
    const lines = [];
    const code = await main(["--wikitom", checkouts.wikitom, "--tom-quest", checkouts.tomQuest, "--json"], {
      write: (text) => lines.push(text),
      error: (text) => lines.push(text),
    });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]).version).toMatch(/^[0-9a-f]{16}$/);
    expect(fs.existsSync(path.join(checkouts.wikitom, "tts/vocabulary.json"))).toBe(false);
  });
});

// ── The prompt's vocabulary block ────────────────────────────────────────────

describe("the closed vocabulary renderer", () => {
  const terms = PROMPT_TERMS.map((term) => ({ term, definition: `The ${term} entry (§5.4). Second \`sentence\`.` }));

  it("renders the opening, then each of the seven named, in order, without section references or emphasis", () => {
    const text = renderClosedVocabulary("Opening:", [...terms].reverse());
    expect(text.split("\n")).toEqual(["Opening:", ...PROMPT_TERMS.map((term) => `- ${term} — The ${term} entry. Second sentence.`)]);
  });

  it("is null, not shorter, when one of the seven is missing or empty", () => {
    expect(renderClosedVocabulary("Opening:", terms.slice(1))).toBeNull();
    expect(renderClosedVocabulary("Opening:", terms.map((entry, index) => (index === 3 ? { ...entry, definition: "(§5.4)" } : entry)))).toBeNull();
  });

  it("keeps the agreed wordings verbatim once the section reference is gone", () => {
    expect(promptDefinition("Needs are the ids a todo or a batch cannot proceed without (§5.4). They are the only ordering mechanism in TTS, at both levels."))
      .toBe("Needs are the ids a todo or a batch cannot proceed without. They are the only ordering mechanism in TTS, at both levels.");
  });
});
