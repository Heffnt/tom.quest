// learning-records.mjs — THE ONE HOME for the two records a model-of-tom
// line is written as.
//
// A file under model-of-tom/ is synthesis for the agent that loads it: no
// quotation, no date, no session id, no citation of any kind. His words live
// in model-of-tom/evidence/<the same path>, under the same heading, in an
// entry whose `line:` repeats the bullet verbatim. WikiTom's
// scripts/check-evidence.mjs is the gate on the pair, and it compares
// `heading + text` exactly — so the entry must take the RENDERED bullet minus
// its leading "- " and never re-wrap it.
//
//   model-of-tom/ground.md            model-of-tom/evidence/ground.md
//   ## Does not know                  ## Does not know
//   - Git beyond add, commit,         - line: Git beyond add, commit, push and pull: git-lfs,
//     push and pull: git-lfs,           overwrite versus merge.
//     overwrite versus merge.           said: 2026-09-08 · session 47f04bc9 · "What is a full
//                                         overwrite versus merge?"
//
// Two callers share this file and must write the pair the same way: the
// nightly learning step (worker/jobs/nightly.mjs) and the one-shot laptop
// memory importer (scripts/import-laptop-memory.mjs). Neither writes a
// synthesis line without its entry, because applyRecords writes both or
// neither.
//
// Plain ESM, one import (markdown-sections.mjs, itself importless): worker/
// is what runs on the Jarvis Box and Node there loads no TypeScript.

import { headings, sectionSpan } from "./markdown-sections.mjs";

/** The four forms an evidence entry's field may take (AGENTS.md § Two
 * records). `dropped:` is a fifth that only evidence/repos/ carries, written
 * by the repo-proposal step, never by a model-of-tom line. */
export const EVIDENCE_FORMS = ["said", "paraphrase", "read", "rests on"];
export const EVIDENCE_FIELDS = [...EVIDENCE_FORMS, "dropped"];
/** What separates an entry's date, source and text. U+00B7, spaced. */
export const EVIDENCE_SEP = " · ";
export const EVIDENCE_DIR = "model-of-tom/evidence";
/** The one mark a synthesis line may carry. */
export const INFERRED_MARK = " (inferred)";

const INFERRED_AT_END = / \(inferred\)$/;
const ENTRY_LINE = /^- line: (.*\S)\s*$/;
const ENTRY_FIELD = new RegExp(`^\\s+(${EVIDENCE_FIELDS.join("|")}): (.*)$`);

// ── Text, as the two records compare it ──────────────────────────────────────
// writing.md is hard-wrapped: one bullet runs over several physical lines,
// the continuation lines indented. A replacement or a revert that worked on
// physical lines would replace the first line of a bullet and leave its tail
// as a stray, so the unit here is the bullet whole, matched with whitespace
// normalized — the model may quote it as the page wraps it or as one line,
// and a bullet Tom re-wrapped still matches.
const BULLET = /^\s*[-*]\s+\S/;
const CONTINUATION = /^\s+\S/;

/** A bullet's text (or any text) as one line: each line trimmed, joined by a
 * space, runs of whitespace collapsed. The form bullets are compared in. */
export function oneLine(text) {
  return String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** How many words `text` holds, in the one-line form. */
export function wordCount(text) {
  return oneLine(text).split(" ").filter((w) => w !== "").length;
}

/** The bullets within `span` as [start, end) line ranges. */
export function bulletUnits(lines, span) {
  const units = [];
  for (let i = span.start + 1; i < span.end; i++) {
    if (!BULLET.test(lines[i])) continue;
    let end = i + 1;
    while (end < span.end && CONTINUATION.test(lines[end]) && !BULLET.test(lines[end])) end++;
    units.push({ start: i, end });
    i = end - 1;
  }
  return units;
}

/** A bullet as it is compared: one line, and its marker gone — the model may
 * quote a bullet with or without the leading "- ", and the same bullet is
 * meant either way. */
export function bulletBody(text) {
  return oneLine(text).replace(/^[-*]\s+/, "");
}

/**
 * Every unit within `span` whose one-line form equals `text`'s. A caller that
 * will REMOVE OR REPLACE a bullet acts only on exactly one match: with two,
 * which is the learned copy and which is Tom's cannot be told from the text,
 * and taking the first would take his while the job's stayed.
 */
export function findBullets(lines, span, text) {
  const wanted = bulletBody(text);
  if (wanted === "") return [];
  return bulletUnits(lines, span).filter(
    (unit) => bulletBody(lines.slice(unit.start, unit.end).join("\n")) === wanted,
  );
}

// ── Where the entry lives ────────────────────────────────────────────────────
/** "model-of-tom/ground.md" → "model-of-tom/evidence/ground.md". Null for a
 * path outside model-of-tom/; an evidence path is returned as it is. */
export function evidencePath(file) {
  const rel = String(file ?? "").replaceAll("\\", "/");
  if (!rel.startsWith("model-of-tom/")) return null;
  const tail = rel.slice("model-of-tom/".length);
  if (tail === "") return null;
  if (tail.startsWith("evidence/")) return rel;
  return `${EVIDENCE_DIR}/${tail}`;
}

// ── Rendering ────────────────────────────────────────────────────────────────
/**
 * The synthesis bullet: "- <line>", with " (inferred)" when the change is
 * one. A line the model already wrote with a leading "- ", or already marked,
 * is not doubled.
 */
export function renderSynthesisLine(change) {
  const raw = String(change?.line ?? "").trim();
  const body = raw.replace(/^[-*]\s+/, "").trim();
  if (body === "") return "";
  const marked =
    change?.inferred === true && !INFERRED_AT_END.test(body) ? `${body}${INFERRED_MARK}` : body;
  return `- ${marked}`;
}

/**
 * The evidence entry, exactly as check-evidence.mjs parses it:
 *
 *   - line: <the bullet's text, without the leading "- ">
 *     said: 2026-09-08 · session 47f04bc9 · "his words"
 *     rests on: 2026-09-08 · session 47f04bc9 · the inference and its basis
 *
 * `said:` alone quotes its text; the other three do not. `line` is the
 * RENDERED bullet (renderSynthesisLine's return), so the entry's `line:` and
 * the page's bullet are the same characters, mark included.
 */
export function renderEvidenceEntry(change, line) {
  const text = oneLine(String(line ?? "").replace(/^[-*]\s+/, ""));
  const out = [`- line: ${text}`];
  for (const e of change?.evidence ?? []) {
    const form = String(e?.form ?? "");
    const body = oneLine(e?.text);
    out.push(
      `  ${form}: ${e?.date ?? ""}${EVIDENCE_SEP}${e?.source ?? ""}${EVIDENCE_SEP}${
        form === "said" ? `"${body}"` : body
      }`,
    );
  }
  return out.join("\n");
}

// ── Reading the evidence file ────────────────────────────────────────────────
/**
 * Every entry in an evidence file: `{heading, line, fields, raw, start, end}`
 * — `fields` is `[{form, date, source, text}]` with the text taken as
 * EVERYTHING after the second separator, so an entry text holding a "·" is
 * not split; `raw` is the entry's own lines, and [start, end) is where they
 * sit, so a caller can splice one out without re-rendering the rest.
 */
export function parseEvidenceEntries(text) {
  const lines = String(text ?? "").split("\n");
  const headAt = new Map();
  for (const h of headings(lines)) {
    for (let k = 0; k < h.lines; k++) headAt.set(h.index + k, h.text);
  }
  const out = [];
  let heading = null;
  let cur = null;
  const close = (end) => {
    if (cur !== null) cur.end = end;
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    if (headAt.has(i)) {
      close(i);
      heading = headAt.get(i);
      continue;
    }
    const entry = ENTRY_LINE.exec(lines[i]);
    if (entry) {
      close(i);
      cur = { heading, line: entry[1], fields: [], raw: [lines[i]], start: i, end: lines.length };
      out.push(cur);
      continue;
    }
    if (cur === null) continue;
    const field = ENTRY_FIELD.exec(lines[i]);
    if (field) {
      const parts = field[2].split(EVIDENCE_SEP);
      cur.fields.push({
        form: field[1],
        date: parts[0] ?? "",
        source: parts[1] ?? "",
        text: parts.slice(2).join(EVIDENCE_SEP),
      });
      cur.raw.push(lines[i]);
      continue;
    }
    if (CONTINUATION.test(lines[i])) {
      cur.raw.push(lines[i]);
      continue;
    }
    close(i);
  }
  close(lines.length);
  return out;
}

/** The entries under `section` (case-insensitive) whose `line:` is `lineText`
 * one-lined. The section "" matches any heading. */
function entriesFor(text, section, lineText) {
  const name = String(section ?? "").trim().toLowerCase();
  const wanted = oneLine(String(lineText ?? "").replace(/^[-*]\s+/, ""));
  return parseEvidenceEntries(text).filter(
    (e) =>
      (name === "" || String(e.heading ?? "").trim().toLowerCase() === name) &&
      oneLine(e.line) === wanted,
  );
}

// ── Writing the evidence file ────────────────────────────────────────────────
/**
 * `entryLines` under `section` of the evidence file `text`.
 *
 * When the file has no such heading the writer APPENDS one at `level` — the
 * level the heading has on the synthesis page — and puts the entry under it;
 * the checker compares heading text, not position, so appending is safe.
 * Entries under a heading are adjacent, no blank line between them, exactly
 * as the hand-written files are.
 *
 * `replaces` names the entry this one supersedes, by the bullet it belongs
 * to. Exactly one match is required — the same "two copies cannot be told
 * apart" rule the synthesis side keeps — and this is AGENTS.md's "when two
 * entries under one line conflict, the newer governs the line; the older is
 * removed".
 */
export function applyEvidenceEntry(text, section, level, entryLines, { replaces = null } = {}) {
  const lines = String(text ?? "").split("\n");
  const name = String(section ?? "").trim();
  const entry = String(entryLines ?? "").split("\n");
  if (replaces !== null && replaces !== "") {
    const hits = entriesFor(lines.join("\n"), name, replaces);
    if (hits.length === 0) {
      return { ok: false, reason: `the line to replace has no evidence entry under "${name}"` };
    }
    if (hits.length > 1) {
      return {
        ok: false,
        reason: `the line to replace has ${hits.length} evidence entries under "${name}"; which one cannot be told`,
      };
    }
    const [hit] = hits;
    lines.splice(hit.start, hit.end - hit.start, ...entry);
    return { ok: true, text: lines.join("\n"), before: hit.raw.join("\n") };
  }
  const span = sectionSpan(lines, name);
  if (span === null) {
    const depth = Math.max(1, Math.min(6, Number(level) || 2));
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", `${"#".repeat(depth)} ${name}`, "", ...entry, "");
    return { ok: true, text: lines.join("\n") };
  }
  let last = span.start;
  for (let i = span.start + 1; i < span.end; i++) if (lines[i].trim() !== "") last = i;
  if (last === span.start) lines.splice(last + 1, 0, "", ...entry);
  else lines.splice(last + 1, 0, ...entry);
  return { ok: true, text: lines.join("\n") };
}

/**
 * Take one entry out, whole (its `line:` and its indented fields). `section`
 * "" looks under every heading. `missing` says the entry was already gone,
 * which a revert treats as success — refusing there would strand Tom's
 * objection, and the checker passes either way.
 */
export function removeEvidenceEntry(text, section, lineText) {
  const lines = String(text ?? "").split("\n");
  const name = String(section ?? "").trim();
  const hits = entriesFor(lines.join("\n"), name, lineText);
  if (hits.length === 0) {
    return { ok: false, missing: true, reason: `no evidence entry under "${name}" for the line` };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      missing: false,
      reason: `the line has ${hits.length} evidence entries under "${name}"; none was taken back`,
    };
  }
  const [hit] = hits;
  lines.splice(hit.start, hit.end - hit.start);
  return { ok: true, text: lines.join("\n"), removed: hit.raw.join("\n") };
}

// ── The pair, written together ───────────────────────────────────────────────
/** The section locator a caller with no guard of its own gets: the heading,
 * wherever it is. The nightly step passes its own, which refuses Tom's
 * sections and anything nested under them. */
function defaultLocate(lines, file, section) {
  const span = sectionSpan(lines, section);
  return span === null ? { reason: `no section "${section}" on ${file}` } : { span };
}

/**
 * ONE validated change into BOTH records. Pure: the two texts in, the two
 * texts out, and neither is written without the other.
 *
 * `change` is `{file, section, op, line, replaces, inferred, evidence}` —
 * already checked by the caller's rules (the nightly step's learningRefusal,
 * or the importer's routing file). `locate` is the caller's section guard.
 *
 * Returns `{ok, pageText, evidenceText, line, entry, before, beforeEntry}`.
 * `before` is the replaced bullet as one line and `beforeEntry` its entry's
 * lines, which is what a revert of a replacement restores.
 */
export function applyRecords(pageText, evidenceText, change, { locate = defaultLocate } = {}) {
  const section = String(change?.section ?? "").trim();
  const op = change?.op ?? (change?.replaces ? "replace" : "add");
  const line = op === "remove" ? "" : renderSynthesisLine(change);
  if (op !== "remove" && line === "") {
    return { ok: false, reason: "the line must be one non-empty line" };
  }
  const lines = String(pageText ?? "").split("\n");
  const located = locate(lines, change?.file, section);
  if (located.span === undefined) return { ok: false, reason: located.reason };
  const { span } = located;
  let before = "";
  let beforeEntry = "";
  if (op === "add") {
    if (findBullets(lines, { start: -1, end: lines.length }, line).length > 0) {
      return { ok: false, reason: "already on the page" };
    }
    let last = span.start;
    for (let i = span.start + 1; i < span.end; i++) if (lines[i].trim() !== "") last = i;
    if (last === span.start) lines.splice(last + 1, 0, "", line);
    else lines.splice(last + 1, 0, line);
  } else {
    const units = findBullets(lines, span, change?.replaces);
    if (units.length === 0) {
      return { ok: false, reason: `the line to replace is not in "${section}" verbatim` };
    }
    if (units.length > 1) {
      return {
        ok: false,
        reason: `the line to replace is in "${section}" ${units.length} times; which one cannot be told`,
      };
    }
    const [unit] = units;
    before = oneLine(lines.slice(unit.start, unit.end).join("\n"));
    lines.splice(unit.start, unit.end - unit.start, ...(op === "remove" ? [] : [line]));
  }
  const entry = op === "remove" ? "" : renderEvidenceEntry(change, line);
  let evidence;
  if (op === "remove") {
    evidence = removeEvidenceEntry(evidenceText, section, before);
    // A removal whose entry is already gone still removes the bullet: the
    // checker fails on a LINE with no entry, never on an entry-less removal.
    if (!evidence.ok && evidence.missing !== true) return { ok: false, reason: evidence.reason };
    if (!evidence.ok) evidence = { ok: true, text: String(evidenceText ?? ""), removed: "" };
    beforeEntry = evidence.removed ?? "";
  } else {
    evidence = applyEvidenceEntry(evidenceText, section, span.level, entry, {
      replaces: op === "replace" ? before : null,
    });
    if (!evidence.ok) return { ok: false, reason: evidence.reason };
    beforeEntry = evidence.before ?? "";
  }
  return {
    ok: true,
    pageText: lines.join("\n"),
    evidenceText: evidence.text,
    line,
    entry,
    before,
    beforeEntry,
  };
}

/**
 * The inverse of one applied change on both records: the bullet goes back to
 * what it replaced (or out), and its entry with it.
 *
 * `change` is the recorded `learning-change` row. `beforeEntry` on the row is
 * the replaced entry's lines; a row that predates the field cannot restore
 * one, and a page line with no entry FAILS the checker — so a replacement
 * whose row carries `before` and no `beforeEntry` is refused rather than left
 * half-reverted.
 */
export function revertRecords(pageText, evidenceText, change, { locate = defaultLocate } = {}) {
  const after = String(change?.after ?? "").trim();
  if (after === "") return { ok: false, reason: "the change records no line to look for" };
  const before = oneLine(change?.before);
  const beforeEntry = String(change?.beforeEntry ?? "");
  if (before !== "" && beforeEntry.trim() === "") {
    return { ok: false, reason: "the change predates the evidence record; revert it by hand" };
  }
  const lines = String(pageText ?? "").split("\n");
  const section = String(change?.section ?? "").trim();
  const located = locate(lines, change?.file, section);
  if (located.span === undefined) return { ok: false, reason: located.reason };
  const { span } = located;
  const units = findBullets(lines, span, after);
  if (units.length === 0) {
    return { ok: false, reason: `the line is no longer in "${section}" on ${change?.file} as written` };
  }
  if (units.length > 1) {
    return {
      ok: false,
      reason: `the line is in "${section}" on ${change?.file} ${units.length} times — the learned copy cannot be told from the others, so none was taken back`,
    };
  }
  const [unit] = units;
  lines.splice(unit.start, unit.end - unit.start, ...(before === "" ? [] : [before]));
  // The entry half. Gone already is not a failure: the page is what a prompt
  // loads, and refusing here would strand his objection.
  const taken = removeEvidenceEntry(evidenceText, section, after);
  if (!taken.ok && taken.missing !== true) return { ok: false, reason: taken.reason };
  let text = taken.ok ? taken.text : String(evidenceText ?? "");
  const evidenceMissing = !taken.ok;
  if (before !== "") {
    const put = applyEvidenceEntry(text, section, span.level, beforeEntry, { replaces: null });
    if (!put.ok) return { ok: false, reason: put.reason };
    text = put.text;
  }
  return { ok: true, pageText: lines.join("\n"), evidenceText: text, evidenceMissing };
}
