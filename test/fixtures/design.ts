// Fixtures for the tests of tom.quest/design's record side
// (convex/jarvis/design.ts): a small registry, the model-of-tom files its
// sentences are read from, and the rows a part's state rests on.

import type { convexTest } from "convex-test";

export const DAY = 24 * 60 * 60 * 1000;
export const NOW = 1_800_000_000_000;
const JSON_HEADERS = { "Content-Type": "application/json", "X-Jarvis-Key": "k" };

export type T = ReturnType<typeof convexTest>;

/** A POST with the worker key the tests stub as JARVIS_KEY "k". */
export const post = (t: T, path: string, body: unknown) => t.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

/** Tom, signed in. */
export async function tom(t: T) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@example.test", role: "tom" }));
  return t.withIdentity({ subject: id });
}

/** A complete registry row: every field Jarvis scripts/check-parts.mjs requires. */
export const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: "program",
  file: null,
  starts: [],
  reads: [],
  writes: [],
  refuses: [],
  routes: [],
  schedule: null,
  fate: { type: "kept", by: null },
  serves: [{ guarantee: "G4" }],
  designed_by: "outcomes",
  note: `The ${id} part of the fixture.`,
  place: { overview: { x: 30, y: 62, region: "box" }, fate: { x: 30, y: 62 } },
  ...extra,
});

export const PARTS: Record<string, unknown>[] = [
  row("ran", { schedule: "ran", file: "worker/jobs/ran.mjs", serves: [{ evidence: "intent.md#Fixture entries#the ran part serves this fixture line" }, { evidence: "intent.md#No such heading#a line" }, { guarantee: "G4" }] }),
  row("broken"),
  row("gone", { fate: { type: "removed", by: null }, schedule: "gone", file: "worker/jobs/gone.mjs" }),
  row("outcome-only", { serves: [{ outcomes: ["cost"] }] }),
  row("idle"),
];

/** The registry row the box's deploy job posts for a commit. */
export const registryBody = (sha: string, parts: Record<string, unknown>[] = PARTS) => ({
  kind: "registry",
  subject: `Jarvis@${sha}`,
  provenance: { job: "deploy" },
  data: { id: `registry:Jarvis@${sha}`, repo: "Jarvis", sha, parts, count: parts.length },
  text: `registry of Jarvis at ${sha.slice(0, 7)}: ${parts.length} parts`,
});

export const EVIDENCE = [
  "# Evidence for the fixture",
  "",
  "## Fixture entries",
  "",
  "- line: the ran part serves this fixture line, and more words after.",
  '  said: 2026-10-04 · session aaa9ae16 · "the sentence the fixture said"',
  "  read: 2026-10-04 · an agent's reading, not a sentence of his",
  "- line: another entry",
  '  said: 2026-10-01 · thread · "another sentence"',
  "",
].join("\n");

const RULES = "### Guarantees\n- G4 the fixture guarantee line.\n";

/** The model-of-tom files, the clean runs of "ran" and an issue on "broken". */
export async function seed(t: T) {
  await t.run(async (ctx) => {
    await ctx.db.insert("intentSources", { repo: "WikiTom", path: "model-of-tom/evidence/intent.md", body: EVIDENCE, bytes: EVIDENCE.length, commit: "c", syncedAt: 1 });
    await ctx.db.insert("modelOfTomFiles", { name: "agent-rules", body: RULES, sourcePath: "model-of-tom/agent-rules.md", syncedAt: 1 });
    // In the order the record received them: a part's newest row is the one
    // received last (convex/jarvis/partStates.ts).
    await ctx.db.insert("events", { kind: "job-ok", at: NOW - 40 * DAY, provenance: { job: "ran" }, subject: "ran:run", data: {} });
    await ctx.db.insert("events", { kind: "job-ok", at: NOW - 2 * DAY, provenance: { job: "ran" }, subject: "ran:run", data: {} });
    await ctx.db.insert("events", { kind: "job-ok", at: NOW - DAY, provenance: { job: "ran" }, subject: "ran:run", data: {} });
    await ctx.db.insert("events", { kind: "issue", at: NOW - DAY, provenance: {}, subject: "broken", data: { part: "broken", by: "tom" }, text: "it is broken" });
  });
}

/** A ruling row in a scope, as the record stores one. */
export const rulingRow = (scope: string, sentence: string, at: number, extra: Record<string, unknown> = {}) => ({
  kind: "ruling",
  at,
  provenance: { session: "s1" },
  subject: scope,
  data: { id: `ruling:${at.toString(16).padStart(64, "0")}`, sentence, scope, question: "q", provenance: { session: "s1" }, standing: true, ...extra },
  text: sentence,
});
