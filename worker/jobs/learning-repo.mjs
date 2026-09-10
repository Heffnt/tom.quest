// learning-repo.mjs — the repo-learning step's reading half.
//
// The nightly learning step maintains what the agents know about TOM. This
// one maintains what they know about his REPOSITORIES: the nested AGENTS.md
// files, which every agent working in a directory reads. Its input is the
// sessions that finished in his repositories since the last run — what each
// was for, how it ended, the shell commands it ran, the tool results that
// failed, and the last things the agent said — and what it proposes is a line
// the NEXT agent in that directory would otherwise learn the same expensive
// way.
//
// WHAT IT WRITES AND WHAT IT DOES NOT. The rule file lives in another
// repository and merges through that repository's own checks, so this step
// never edits it. Tonight it writes ONE thing: the evidence entry, in WikiTom,
// under a heading that says the line is not in the repository yet
// (`## worker/AGENTS.md#box — proposed`). The digest prints the proposal with
// its id; a later session applies it and posts back; the NEXT night's step
// moves the entry from the proposed heading to the live one. Tom's reply on
// the digest line drops it instead.
//
// Plain ESM, node: builtins only.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { CHANGE_ID_CHARS } from "./learning-change-names.mjs";
import { EVIDENCE_SEP, oneLine, parseEvidenceEntries } from "./learning-records.mjs";

/** Sessions read per night, and at most REPO_SESSIONS_PER_REPO of them from
 * any one repository, so a busy repository does not take the night. */
export const REPO_SESSIONS_MAX = 8;
export const REPO_SESSIONS_PER_REPO = 3;
/** One session's transcript evidence in the prompt. */
export const REPO_TRANSCRIPT_CHARS = 12_000;
/** The repository's own AGENTS.md files in the prompt, all of them together. */
export const REPO_RULES_CHARS = 20_000;
/** Proposals a night, after dedupe. Tom's cap. */
export const REPO_PROPOSALS_MAX = 5;
/** How far back dedupe looks at what has already been proposed. */
export const REPO_PROPOSAL_TTL_DAYS = 90;
/** One line of a transcript in the prompt. */
export const REPO_LINE_CHARS = 300;
/** The last assistant texts of a session that are shown. */
export const REPO_ASSISTANT_TEXTS = 6;
/** How deep under a session's cwd nested AGENTS.md files are read. */
export const REPO_RULES_DEPTH = 2;

export const REPO_PROPOSAL = "repo-proposal";
export const REPO_PROPOSAL_APPLIED = "repo-proposal-applied";
export const REPO_PROPOSAL_DROPPED = "repo-proposal-dropped";
export const REPO_LEARNING_RUN = "repo-learning-run";
/** What a heading says while the line is not in the repository yet. */
export const PROPOSED_SUFFIX = " — proposed";
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Where the evidence goes ──────────────────────────────────────────────────
/** `model-of-tom/evidence/repos/<repo>.md`. The repo name is a path segment
 * as the session rows carry it; anything else is refused by returning null. */
export function repoEvidencePath(repo) {
  const name = String(repo ?? "").trim();
  if (name === "" || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") return null;
  return `model-of-tom/evidence/repos/${name}.md`;
}

/** The heading one proposal's entry sits under, before and after it lands. */
export function proposalHeading(file, section, { proposed = false } = {}) {
  const at = String(section ?? "").trim();
  const base = at === "" ? String(file ?? "") : `${file}#${at}`;
  return proposed ? `${base}${PROPOSED_SUFFIX}` : base;
}

// ── Comparing two sentences ──────────────────────────────────────────────────
/**
 * A sentence reduced for comparison: lowercased, backticks and quotes gone,
 * punctuation to spaces, whitespace collapsed, a leading "- " gone. Two
 * wordings that differ only in punctuation are the same rule; two that differ
 * in a word are not.
 */
export function normalizeSentence(text) {
  return String(text ?? "")
    .replace(/^\s*[-*]\s+/, "")
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The stable id of one proposal: the repository, the file, the section and
 * the rule. The same rule proposed twice is the same proposal. Its length and
 * alphabet are a learning change's, which is how Tom names it back. */
export function proposalId(repo, file, section, line) {
  return crypto
    .createHash("sha256")
    .update(`${repo}\n${file}\n${section}\n${normalizeSentence(line)}`)
    .digest("hex")
    .slice(0, CHANGE_ID_CHARS);
}

// ── The archived transcript ──────────────────────────────────────────────────
/**
 * The archived transcript's path in the checkout, relative to it, or null.
 *
 * Both layouts of sessions/README.md: `claude-<id>/session.jsonl.gz`, and —
 * where one session id was written under two box accounts —
 * `claude-<id>/<account>/session.jsonl.gz`. A session that started before
 * midnight is archived under the day its FIRST line carries, which can be
 * either side of the day its row moved to "ended", so both neighbours of
 * `day` are searched.
 */
export function transcriptPath(dir, sdkSessionId, day) {
  const id = String(sdkSessionId ?? "").trim();
  if (id === "" || !/^[0-9a-zA-Z._-]+$/.test(id)) return null;
  for (const on of [day, dayBefore(day), dayAfter(day)]) {
    if (on === null) continue;
    const base = `sessions/${on.replaceAll("-", "/")}/claude-${id}`;
    const abs = path.join(dir, base);
    if (!fs.existsSync(abs)) continue;
    const flat = `${base}/session.jsonl.gz`;
    if (fs.existsSync(path.join(dir, flat))) return flat;
    // The per-account layout: one directory per account under the session's.
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = `${base}/${entry.name}/session.jsonl.gz`;
      if (fs.existsSync(path.join(dir, nested))) return nested;
    }
  }
  return null;
}

function shiftDay(day, by) {
  const s = String(day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + by * DAY_MS).toISOString().slice(0, 10);
}
const dayBefore = (day) => shiftDay(day, -1);
const dayAfter = (day) => shiftDay(day, 1);

/** Every object nested anywhere in `value`, so a transcript line's shape can
 * change without this reader going blind to it. */
function* objectsIn(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* objectsIn(item, depth + 1);
    return;
  }
  yield value;
  for (const item of Object.values(value)) yield* objectsIn(item, depth + 1);
}

const clipLine = (text, chars = REPO_LINE_CHARS) => {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length <= chars ? one : `${one.slice(0, chars - 1)}…`;
};

/** A tool result's text, however the SDK wrapped it. */
function resultText(result) {
  const content = result.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  }
  return typeof result.text === "string" ? result.text : "";
}

/**
 * What the model is shown for one session, from its transcript: only the
 * lines that carry REPO KNOWLEDGE —
 *
 *   - every shell command the session ran (a `Bash` tool_use, its `command`)
 *   - every failed tool result's first line
 *   - the last REPO_ASSISTANT_TEXTS assistant-text blocks
 *
 * each clipped to REPO_LINE_CHARS — a 32KB assistant block is CLIPPED, never
 * dropped whole, because the thing worth reading is usually its first
 * sentence — newest first, up to `chars`.
 */
export function transcriptEvidence(gzBytes, { chars = REPO_TRANSCRIPT_CHARS } = {}) {
  let text;
  try {
    text = zlib.gunzipSync(gzBytes).toString("utf8");
  } catch {
    return "";
  }
  const commands = [];
  const failures = [];
  const says = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const obj of objectsIn(line)) {
      if (obj.type === "tool_use" && obj.name === "Bash" && typeof obj.input?.command === "string") {
        commands.push(`ran: ${clipLine(obj.input.command)}`);
      } else if (obj.type === "tool_result" && obj.is_error === true) {
        const first = resultText(obj).split("\n").find((l) => l.trim() !== "") ?? "";
        if (first !== "") failures.push(`failed: ${clipLine(first)}`);
      } else if (obj.type === "text" && typeof obj.text === "string" && obj.text.trim() !== "") {
        says.push(`said: ${clipLine(obj.text)}`);
      }
    }
  }
  // Newest first within each kind, and the assistant's last words only.
  const out = [
    ...commands.reverse(),
    ...failures.reverse(),
    ...says.slice(-REPO_ASSISTANT_TEXTS).reverse(),
  ];
  const kept = [];
  let used = 0;
  for (const line of out) {
    if (used + line.length + 1 > chars) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join("\n");
}

/**
 * The sessions the night reads: newest first, at most REPO_SESSIONS_MAX, at
 * most REPO_SESSIONS_PER_REPO from any one repository.
 */
export function chooseSessions(sessions, { max = REPO_SESSIONS_MAX, perRepo = REPO_SESSIONS_PER_REPO } = {}) {
  const byRepo = new Map();
  const kept = [];
  for (const s of [...(sessions ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    const repo = String(s.repo ?? "");
    const seen = byRepo.get(repo) ?? 0;
    if (seen >= perRepo) continue;
    byRepo.set(repo, seen + 1);
    kept.push(s);
    if (kept.length >= max) break;
  }
  return kept;
}

/**
 * The repository's own rules, read from the session's cwd on the box: its
 * root AGENTS.md and every nested AGENTS.md up to REPO_RULES_DEPTH levels
 * down, to REPO_RULES_CHARS in all. `missing` is true when the
 * cwd is gone or holds none, which the digest says, because a proposal
 * checked against no file at all is checked against the evidence record only.
 */
export function readRepoRules(cwd, { chars = REPO_RULES_CHARS, depth = REPO_RULES_DEPTH } = {}) {
  const root = typeof cwd === "string" && cwd !== "" && fs.existsSync(cwd) ? cwd : null;
  if (root === null) return { files: [], missing: true };
  const files = [];
  const walk = (rel, left) => {
    const abs = rel === "" ? root : path.join(root, rel);
    const named = path.join(abs, "AGENTS.md");
    if (fs.existsSync(named)) {
      files.push({ path: rel === "" ? "AGENTS.md" : `${rel}/AGENTS.md`.replaceAll("\\", "/"), text: fs.readFileSync(named, "utf8") });
    }
    if (left <= 0) return;
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      walk(rel === "" ? entry.name : `${rel}/${entry.name}`, left - 1);
    }
  };
  walk("", depth);
  let used = 0;
  const kept = [];
  for (const f of files) {
    const block = `=== ${f.path} ===\n${f.text}`;
    if (used + block.length > chars) break;
    kept.push(f);
    used += block.length;
  }
  return { files: kept, missing: kept.length === 0 };
}

/** Every bullet of every rule file, for dedupe. */
export function repoRuleBullets(files) {
  const out = [];
  for (const f of files ?? []) {
    for (const raw of String(f.text ?? "").split("\n")) {
      const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(raw);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

// ── The prompt ───────────────────────────────────────────────────────────────
export function repoLearningPrompt(sessions, repoFiles, entries, day) {
  return [
    "You maintain the rule files of Tom's repositories: the AGENTS.md at a repository's root and in each of its directories, which every agent working in that directory reads. Tonight's input is the sessions that finished in his repositories since the last run — what each one was for, how it ended, the shell commands it ran, the tool results that failed, and the last things the agent said. Propose the lines those sessions justify, and nothing else.",
    "",
    "WHAT A LINE IS",
    "- A convention the session discovered, a trap it hit, or a command that worked: something the NEXT agent in that directory would otherwise learn the same expensive way.",
    "- One line, present tense, imperative or second person, plain: the mechanism and nothing else. No quotation, no date, no session id, no analogy, no evaluative word. It is a rule a reader follows, not a story about a session.",
    "- It belongs to the nearest directory that owns it: a Convex rule to convex/AGENTS.md, a box-job rule to worker/AGENTS.md, a rule true of the whole repository to the root AGENTS.md. Name the file by its path from the repository root.",
    "- Never a fact about one run: a number, a branch name, a PR number, a date, a person. Never a restatement of a line already in the files below. Never a rule about Tom — those live in another record.",
    "",
    "EVIDENCE",
    '- Every proposal cites the sessions it was read from: "sources" is a list of session ids from the input, and "read" is the fact you read there, in one sentence, naming the command or the failure it came from.',
    "- A proposal you cannot trace to a command, a tool result or the session's own outcome is not a proposal.",
    "",
    `- At most ${REPO_PROPOSALS_MAX} proposals. An empty list is the right answer on a night whose sessions taught nothing, and that is most nights.`,
    "",
    "Answer with ONE JSON object and nothing else, no code fence:",
    '{"proposals":[{"repo":"tom.quest","file":"worker/AGENTS.md","section":"box","line":"...","sources":["47f04bc9"],"read":"..."}]}',
    "",
    // The rarely-changing text first — the rule files and the record barely
    // move night to night, so the prompt cache holds across runs only while
    // they sit ABOVE tonight's sessions, which change every run.
    "THE FILES AS THEY STAND",
    repoFiles,
    "",
    "PROPOSALS AND LINES ALREADY ON RECORD (never propose a duplicate)",
    entries,
    "",
    "SESSIONS",
    JSON.stringify(sessions, null, 1),
    "",
    `Tonight is ${day} (UTC).`,
  ].join("\n");
}

/** The model's answer as a list of raw proposals. The thrown message is a
 * REASON, never the answer — the same rule the learning answer keeps. */
export function parseRepoAnswer(answerText, extractJsonObject) {
  let obj;
  try {
    obj = extractJsonObject(answerText);
  } catch (err) {
    throw new Error(
      err instanceof SyntaxError
        ? "the repo-learning answer is not valid JSON"
        : "the repo-learning answer holds no JSON object",
    );
  }
  if (obj === null || typeof obj !== "object" || !Array.isArray(obj.proposals)) {
    throw new Error("the repo-learning answer has no `proposals` array");
  }
  return obj.proposals;
}

// ── Dedupe and the cap ───────────────────────────────────────────────────────
/**
 * The proposals that survive. A proposal is DROPPED — not refused; dropped,
 * with a reason in the summary — when its normalized sentence equals one
 * already in the repository's own files, one already on the evidence record,
 * or one proposed in the last REPO_PROPOSAL_TTL_DAYS nights whatever became
 * of it. What survives is capped at REPO_PROPOSALS_MAX, newest session first.
 *
 * `known` is `{bullets, entryLines, priorSentences}` — three lists of raw
 * sentences, each normalized here.
 */
export function dedupeProposals(proposals, known, { max = REPO_PROPOSALS_MAX } = {}) {
  const seen = new Set(
    [...(known?.bullets ?? []), ...(known?.entryLines ?? []), ...(known?.priorSentences ?? [])]
      .map(normalizeSentence)
      .filter((s) => s !== ""),
  );
  const kept = [];
  const dropped = [];
  for (const p of proposals ?? []) {
    const norm = normalizeSentence(p?.line);
    if (norm === "") {
      dropped.push({ proposal: p, reason: "the proposal has no line" });
      continue;
    }
    if (seen.has(norm)) {
      dropped.push({ proposal: p, reason: "a duplicate of a line already in the files or on record" });
      continue;
    }
    seen.add(norm);
    if (kept.length >= max) {
      dropped.push({ proposal: p, reason: `past the ${max}-proposal cap for one night` });
      continue;
    }
    kept.push(p);
  }
  return { kept, dropped };
}

/** The sentences of every proposal made in the last `ttlDays` nights, from
 * the `repo-proposal` rows the input carries. */
export function priorProposalSentences(rows, day, { ttlDays = REPO_PROPOSAL_TTL_DAYS } = {}) {
  const floor = shiftDay(day, -ttlDays);
  const out = [];
  for (const r of rows ?? []) {
    const d = r?.day ?? r?.data?.day;
    if (floor !== null && typeof d === "string" && d < floor) continue;
    const line = r?.line ?? r?.data?.line;
    if (typeof line === "string" && line.trim() !== "") out.push(line);
  }
  return out;
}

// ── The entry ────────────────────────────────────────────────────────────────
/** One proposal's evidence entry: its line, and the fact it was read from. */
export function renderProposalEntry(proposal, day) {
  const sources = (proposal.sources ?? []).map((s) => String(s).trim()).filter((s) => s !== "");
  const source = sources.length === 0 ? "session unknown" : `session ${sources[0]}`;
  const extra = sources.length > 1 ? ` (${sources.length} sessions)` : "";
  return [
    `- line: ${oneLine(proposal.line)}`,
    `  read: ${day}${EVIDENCE_SEP}${source}${EVIDENCE_SEP}${oneLine(proposal.read)}${extra}`,
  ].join("\n");
}

/** Every `line:` on record in one repository's evidence file, for dedupe. */
export function evidenceLinesOf(text) {
  return parseEvidenceEntries(text ?? "").map((e) => e.line);
}

/**
 * The entry appended under its proposed heading. The heading is created when
 * the file has none — `— proposed` is a heading SUFFIX, so WikiTom's
 * check-evidence.mjs needs no change: under evidence/repos/ it validates
 * entry form and heading presence only.
 */
export function appendProposalEntry(text, heading, entryLines) {
  const body = String(text ?? "");
  const lines = body === "" ? [] : body.split("\n");
  const at = lines.findIndex((l) => headingTextOf(l) === heading);
  if (at === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", `## ${heading}`, "", ...entryLines.split("\n"), "");
    return lines.join("\n");
  }
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (headingTextOf(lines[i]) !== null) {
      end = i;
      break;
    }
  }
  let last = at;
  for (let i = at + 1; i < end; i++) if (lines[i].trim() !== "") last = i;
  if (last === at) lines.splice(last + 1, 0, "", ...entryLines.split("\n"));
  else lines.splice(last + 1, 0, ...entryLines.split("\n"));
  return lines.join("\n");
}

function headingTextOf(line) {
  const m = /^#{1,6}\s+(.*?)\s*$/.exec(String(line ?? ""));
  return m ? m[1] : null;
}

/**
 * A proposal that landed in its repository: the entry moves from
 * `## <file>#<section> — proposed` to `## <file>#<section>`, and its `line:`
 * becomes the wording that actually merged. THE ONLY WRITER of the live
 * heading. Running it twice is a no-op — the entry is already under the live
 * heading and the proposed one no longer holds it.
 */
export function reconcileApplied(text, { file, section, line, appliedLine }) {
  const proposed = proposalHeading(file, section, { proposed: true });
  const live = proposalHeading(file, section);
  const body = String(text ?? "");
  const wanted = normalizeSentence(line);
  const entry = parseEvidenceEntries(body).find(
    (e) => e.heading === proposed && normalizeSentence(e.line) === wanted,
  );
  if (entry === undefined) return { ok: false, moved: false, text: body };
  const lines = body.split("\n");
  const raw = entry.raw.slice();
  const finalLine = typeof appliedLine === "string" && appliedLine.trim() !== "" ? oneLine(appliedLine) : oneLine(line);
  raw[0] = `- line: ${finalLine}`;
  lines.splice(entry.start, entry.end - entry.start);
  return { ok: true, moved: true, text: appendProposalEntry(lines.join("\n"), live, raw.join("\n")) };
}

/**
 * Tom objected. The entry KEEPS its heading and gains a `dropped:` field —
 * the one field check-evidence.mjs allows under evidence/repos/, and this is
 * what it is for: the record says the rule was proposed and why it is not a
 * rule, which is what stops the next night proposing it again.
 */
export function dropProposal(text, { file, section, line, day, reply }) {
  const proposed = proposalHeading(file, section, { proposed: true });
  const body = String(text ?? "");
  const wanted = normalizeSentence(line);
  const entry = parseEvidenceEntries(body).find(
    (e) => (e.heading === proposed || e.heading === proposalHeading(file, section)) && normalizeSentence(e.line) === wanted,
  );
  if (entry === undefined) return { ok: false, text: body };
  const lines = body.split("\n");
  const note = `  dropped: ${day}${EVIDENCE_SEP}Tom's objection${EVIDENCE_SEP}${oneLine(reply).slice(0, 200)}`;
  lines.splice(entry.end, 0, note);
  return { ok: true, text: lines.join("\n") };
}
