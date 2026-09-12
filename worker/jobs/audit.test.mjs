import { describe, expect, it } from "vitest";

import {
  AUDIT_CHUNK_MAX_CHARS,
  AUDIT_FALLBACK_MAX_TURNS,
  AUDIT_FALLBACK_MODEL,
  AUDIT_FALLBACK_TOOLS,
  AUDIT_FALLBACK_REASON,
  AUDIT_MAX_CHUNKS,
  AUDIT_MODEL,
  AUDIT_REMOVAL_HEADING,
  AUDIT_SANDBOX,
  AUDIT_VERDICT_LINE,
  auditCommit,
  auditPrompt,
  chunkDiff,
  chunkSpan,
  composeChunkedAudit,
  diffOf,
  filesOf,
  isCodexCap,
  mergeChunkVerdicts,
  rewriteChunkAnswer,
  traceFindingsOf,
} from "./audit.mjs";

const CHANGE = "diff --git a/x.ts b/x.ts\n+const x = 1;\n";

function io(over = {}) {
  const posted = [];
  return {
    posted,
    io: {
      run: () => CHANGE,
      env: () => ({ CONVEX_SITE_URL: "https://convex.test", TTS_WORKER_KEY: "k" }),
      audit: () => `${AUDIT_VERDICT_LINE}\n\nNothing here breaks anything.`,
      post: async (env, body) => {
        posted.push(body);
        return { verdict: "APPROVED", existing: false };
      },
      ...over,
    },
  };
}

/** One file's block of a diff, `chars` characters long in total. */
function fileBlock(name, chars) {
  const head = `diff --git a/${name} b/${name}\n`;
  const body = `+${"x".repeat(Math.max(1, chars - head.length - 2))}\n`;
  return head + body;
}

// THE TWO ANCHORED READERS convex/ttsMerge.ts runs over the posted text. A `.ts`
// import does not work from a plain-Node vitest file in worker/jobs (the job
// tree has no TypeScript transform of its own), so the regexes are restated
// here CHARACTER-FOR-CHARACTER from auditVerdictOf and removalNotesOf. That is
// the point of the assertions below: the merged text must satisfy the gate's
// own reading, not this file's idea of it.
const GATE_VERDICT_RE = /^[ \t]*VERDICT:[ \t]*([A-Za-z][A-Za-z_-]*)[ \t]*$/im;
const GATE_VERDICT_RE_G = /^[ \t]*VERDICT:[ \t]*([A-Za-z][A-Za-z_-]*)[ \t]*$/gim;
const GATE_HEADING_RE_G = /^[ \t]*REMOVAL CHECK:[ \t]*(.*)$/gim;

/** removalNotesOf, restated. */
function gateRemovalNotes(text) {
  const heading = /^[ \t]*REMOVAL CHECK:[ \t]*(.*)$/im.exec(text);
  if (heading === null) return [];
  if (heading[1].trim().toLowerCase() === "none") return [];
  const after = text.slice(heading.index + heading[0].length).split(/\r?\n/).slice(1);
  const notes = [];
  for (const line of after) {
    if (notes.length >= 20) break;
    const bullet = /^[ \t]*-[ \t]+(.*\S)[ \t]*$/.exec(line);
    if (bullet === null) break;
    notes.push(bullet[1].trim().slice(0, 300));
  }
  return notes;
}

/** capUtf8, restated: the cap is BYTES, not characters. */
function capUtf8(text, maxBytes) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end));
}

describe("auditPrompt", () => {
  const prompt = auditPrompt({
    repo: "tom.quest",
    sha: "a1b2c3d",
    base: "0000000",
    subject: "the merge gate",
    diff: CHANGE,
    truncated: false,
  });

  it("asks ONE question and refuses to make it a taste review", () => {
    expect(prompt).toContain("THE ONE QUESTION");
    expect(prompt).toContain("NOT your question");
    expect(prompt).toContain("never opens");
  });

  it("asks for the verdict alone on its line, and nowhere else", () => {
    expect(prompt).toContain(AUDIT_VERDICT_LINE);
    expect(prompt).toContain("VERDICT: REFUSED");
    expect(prompt).toContain("NOWHERE ELSE");
  });

  it("carries the diff between markers, so quoting inside it is not instructions", () => {
    expect(prompt).toContain("<<<DIFF");
    expect(prompt).toContain("DIFF>>>");
    expect(prompt).toContain(CHANGE);
  });

  it("asks the removal check of every addition, and names the heading it answers under", () => {
    expect(prompt).toContain("THE REMOVAL CHECK");
    expect(prompt).toContain("cannot be deleted instead");
    expect(prompt).toContain(`${AUDIT_REMOVAL_HEADING} none`);
    // A finding, not a fourth thing the branch has to satisfy.
    expect(prompt).toContain("This is a FINDING, not a refusal.");
  });

  it("asks the removal check after the one question and before the answer shape", () => {
    expect(prompt.indexOf("NOT your question")).toBeLessThan(prompt.indexOf("THE REMOVAL CHECK"));
    expect(prompt.indexOf("THE REMOVAL CHECK")).toBeLessThan(prompt.indexOf("Answer in this shape"));
  });

  it("says so when the diff was cut", () => {
    const cut = auditPrompt({ repo: "r", sha: "s", base: null, subject: "", diff: "d", truncated: true });
    expect(cut).toContain("THE DIFF BELOW IS CUT");
  });

  // THE UNCHUNKED PROMPT IS UNCHANGED. A chunked audit and a whole audit must
  // answer in the same words, and the only way to know they were asked the same
  // thing is that the chunk line is the one difference.
  it("says nothing about chunks when it is not one", () => {
    expect(prompt).not.toContain("This is chunk");
  });

  it("names which chunk it is and how big the whole change is, when it is one", () => {
    const chunked = auditPrompt({
      repo: "tom.quest",
      sha: "a1b2c3d",
      base: "0000000",
      subject: "the merge gate",
      diff: CHANGE,
      truncated: false,
      chunk: { index: 2, count: 5, files: 126, chars: 118_432, total: 1_519_624 },
    });
    expect(chunked).toContain(
      "This is chunk 2 of 5 of one change (126 files, 118432 of 1519624 characters). " +
        "Judge what is in this chunk; another auditor is reading the rest.",
    );
    // …and is otherwise byte-for-byte the prompt above.
    expect(chunked.split("\n").filter((line) => !line.startsWith("This is chunk")).join("\n")).toBe(prompt);
  });
});

describe("diffOf", () => {
  it("reads the range against the base, and against the parent without one", () => {
    const seen = [];
    const run = (command, args) => {
      seen.push(args.join(" "));
      return CHANGE;
    };
    diffOf("/w", "sha", "base", run);
    diffOf("/w", "sha", null, run);
    expect(seen[0]).toContain("base..sha");
    expect(seen[1]).toContain("sha~1..sha");
  });

  // The old whole-diff cut is GONE: chunkDiff is the one place that decides
  // what an auditor did not see, and a second ceiling above it could only
  // disagree with it silently.
  it("hands back the whole diff, however large, and says how large", () => {
    const huge = CHANGE + fileBlock("big.ts", AUDIT_CHUNK_MAX_CHARS * 3);
    const answer = diffOf("/w", "sha", null, () => huge);
    expect(answer.diff).toBe(huge);
    expect(answer.chars).toBe(huge.length);
  });
});

describe("chunkDiff", () => {
  it("splits on file boundaries — never inside a hunk", () => {
    const diff = fileBlock("a.ts", 40) + fileBlock("b.ts", 40) + fileBlock("c.ts", 40);
    const chunks = chunkDiff(diff, { maxChars: 90 });
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      // Every chunk starts at a header and holds whole blocks.
      expect(chunk.text.startsWith("diff --git ")).toBe(true);
      expect(chunk.text.match(/^diff --git /gm)).toHaveLength(chunk.files.length);
    }
    expect(chunks.flatMap((one) => one.files)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  // Two audits of the same commit read the same chunks. That is what makes the
  // coverage line comparable and the proof repeatable.
  it("orders the files by path, not by the order git diff emitted them", () => {
    const emitted = fileBlock("z/last.ts", 40) + fileBlock("a/first.ts", 40) + fileBlock("m/mid.ts", 40);
    const chunks = chunkDiff(emitted, { maxChars: 10_000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].files).toEqual(["a/first.ts", "m/mid.ts", "z/last.ts"]);
    // …and the text is in that order too, not the emitted one.
    expect(chunks[0].text.indexOf("a/first.ts")).toBeLessThan(chunks[0].text.indexOf("z/last.ts"));
  });

  it("packs whole files up to the cap and no further", () => {
    const diff = fileBlock("a.ts", 50) + fileBlock("b.ts", 50) + fileBlock("c.ts", 50);
    const chunks = chunkDiff(diff, { maxChars: 100 });
    expect(chunks.map((one) => one.files)).toEqual([["a.ts", "b.ts"], ["c.ts"]]);
    expect(chunks[0].chars).toBeLessThanOrEqual(100);
  });

  it("gives a file larger than the cap its own chunk, cut, and marks only that one", () => {
    const diff = fileBlock("a.ts", 40) + fileBlock("huge.ts", 500) + fileBlock("z.ts", 40);
    const chunks = chunkDiff(diff, { maxChars: 200 });
    const huge = chunks.find((one) => one.files.includes("huge.ts"));
    expect(huge.files).toEqual(["huge.ts"]);
    expect(huge.truncated).toBe(true);
    expect(huge.chars).toBe(200);
    for (const chunk of chunks) {
      if (chunk === huge) continue;
      expect(chunk.truncated).toBe(false);
    }
  });

  // A refusal on size would stop a merge on a number nobody ruled.
  it("carries the remainder in the last chunk, cut, and refuses nothing", () => {
    const files = Array.from({ length: 8 }, (unused, i) => fileBlock(`f${i}.ts`, 100)).join("");
    const chunks = chunkDiff(files, { maxChars: 100, maxChunks: 3 });
    expect(chunks).toHaveLength(3);
    expect(chunks[2].truncated).toBe(true);
    expect(chunks[2].chars).toBe(100);
    const charsRead = chunks.reduce((total, one) => total + one.chars, 0);
    expect(charsRead).toBeLessThan(files.length);
    // Nothing in the answer is a verdict at all: the chunker never refuses.
    expect(chunks.every((one) => typeof one.text === "string")).toBe(true);
  });

  it("lists in the cut last chunk only the files the cut actually reaches", () => {
    const files = Array.from({ length: 6 }, (unused, i) => fileBlock(`f${i}.ts`, 100)).join("");
    const chunks = chunkDiff(files, { maxChars: 250, maxChunks: 2 });
    // 250 characters holds two 100-character blocks and part of a third.
    expect(chunks[1].files.length).toBeLessThan(4);
    expect(chunks[1].truncated).toBe(true);
  });

  it("is empty for an empty diff", () => {
    expect(chunkDiff("")).toEqual([]);
  });

  // The real measurement, against the real constants. The brief's own
  // justification for AUDIT_MAX_CHUNKS ("twelve chunks is more than PR #171")
  // is wrong: 12 × 120,000 = 1,440,000 and PR #171 is 1,519,624 characters.
  it("reads part of a change bigger than twelve chunks hold, and says how much", () => {
    const files = Array.from({ length: 130 }, (unused, i) =>
      fileBlock(`src/f${String(i).padStart(3, "0")}.ts`, 12_000),
    ).join("");
    expect(files.length).toBeGreaterThan(AUDIT_CHUNK_MAX_CHARS * AUDIT_MAX_CHUNKS);
    const chunks = chunkDiff(files);
    expect(chunks).toHaveLength(AUDIT_MAX_CHUNKS);
    const charsRead = chunks.reduce((total, one) => total + one.chars, 0);
    expect(charsRead).toBeLessThan(files.length);
    expect(chunks[AUDIT_MAX_CHUNKS - 1].truncated).toBe(true);
  });
});

describe("filesOf", () => {
  it("names every file the change touches", () => {
    expect(filesOf(fileBlock("a.ts", 40) + fileBlock("b/c.ts", 40))).toEqual(["a.ts", "b/c.ts"]);
  });
});

// ANY REFUSED WINS. An approval that outvoted a refusal is a gate that opens on
// a majority of partial readers.
describe("mergeChunkVerdicts", () => {
  it("approves only when every chunk approved", () => {
    expect(mergeChunkVerdicts(["APPROVED", "APPROVED", "APPROVED"])).toBe("APPROVED");
  });

  it("refuses when one chunk among the approvals refused", () => {
    expect(mergeChunkVerdicts(["APPROVED", "REFUSED", "APPROVED"])).toBe("REFUSED");
  });

  it("is unavailable when one chunk among the approvals was unavailable", () => {
    expect(mergeChunkVerdicts(["APPROVED", "UNAVAILABLE", "APPROVED"])).toBe("UNAVAILABLE");
  });

  it("refuses when a refusal and an unavailable land together", () => {
    expect(mergeChunkVerdicts(["UNAVAILABLE", "REFUSED", "APPROVED"])).toBe("REFUSED");
    expect(mergeChunkVerdicts(["REFUSED", "UNAVAILABLE"])).toBe("REFUSED");
  });

  it("is unavailable when every chunk was", () => {
    expect(mergeChunkVerdicts(["UNAVAILABLE", "UNAVAILABLE"])).toBe("UNAVAILABLE");
  });

  it("counts an unparseable answer as unavailable, never as an approval", () => {
    expect(mergeChunkVerdicts(["APPROVED", null])).toBe("UNAVAILABLE");
    expect(mergeChunkVerdicts([null, null])).toBe("UNAVAILABLE");
    expect(mergeChunkVerdicts([])).toBe("UNAVAILABLE");
  });

  it("counts a word nobody defined as a refusal, never as an approval", () => {
    expect(mergeChunkVerdicts(["APPROVED", "REJECTED"])).toBe("REFUSED");
  });
});

describe("rewriteChunkAnswer", () => {
  it("disarms a chunk's own verdict line and removal heading", () => {
    const answer = `VERDICT: REFUSED\n\nBad.\n\n${AUDIT_REMOVAL_HEADING}\n- a.ts: a flag\n`;
    const safe = rewriteChunkAnswer(answer);
    expect(safe).toContain("chunk verdict: REFUSED");
    expect(safe).toContain("chunk removal check:");
    expect(GATE_VERDICT_RE.test(safe)).toBe(false);
    expect(/^[ \t]*REMOVAL CHECK:/im.test(safe)).toBe(false);
  });

  it("keeps the `none` answer readable after the rewrite", () => {
    expect(rewriteChunkAnswer(`${AUDIT_REMOVAL_HEADING} none`)).toBe("chunk removal check: none");
  });
});

describe("composeChunkedAudit", () => {
  const parts = [
    {
      chunk: { files: ["a/one.ts", "a/two.ts"] },
      text: `${AUDIT_VERDICT_LINE}\n\nNothing in these two files breaks anything.\n\n${AUDIT_REMOVAL_HEADING}\n- a/one.ts: a new flag — the change does not say why the old path cannot be deleted\n`,
    },
    {
      chunk: { files: ["m/mid.ts"] },
      text: `VERDICT: REFUSED\n\nm/mid.ts drops the null check its caller relies on.\n\n${AUDIT_REMOVAL_HEADING} none\n`,
    },
    { chunk: { files: ["z/last.ts"] }, text: "the model wandered off and never wrote a verdict" },
  ];
  const merged = composeChunkedAudit(parts);

  it("writes one merged verdict at the top, any-refused-wins", () => {
    expect(merged.verdict).toBe("REFUSED");
    expect(merged.text.split("\n")[0]).toBe("VERDICT: REFUSED");
  });

  it("counts how many chunks actually answered", () => {
    expect(merged.read).toBe(2);
  });

  // EXACTLY ONE of each anchored thing, even though two chunks wrote their own.
  it("leaves the gate's two anchored readers exactly one match each", () => {
    expect(merged.text.match(GATE_VERDICT_RE_G)).toHaveLength(1);
    expect(merged.text.match(GATE_HEADING_RE_G)).toHaveLength(1);
  });

  it("files every chunk's bullets under the one heading removalNotesOf reads", () => {
    expect(gateRemovalNotes(merged.text)).toEqual([
      "a/one.ts: a new flag — the change does not say why the old path cannot be deleted",
    ]);
  });

  it("writes one short coverage line per chunk, in path order", () => {
    expect(merged.text).toContain("chunk 1/3 a/one.ts…a/two.ts: APPROVED");
    expect(merged.text).toContain("chunk 2/3 m/mid.ts: REFUSED");
    expect(merged.text).toContain("chunk 3/3 z/last.ts: UNAVAILABLE");
  });

  it("puts the reason paragraphs last, where the cut eats them first", () => {
    expect(merged.text.indexOf("chunk 3/3")).toBeLessThan(merged.text.indexOf("--- chunk 1 of 3 ---"));
  });

  // The whole point of the order: convex/ttsMerge.ts keeps 8 KiB OF BYTES.
  it("survives the row's 8 KiB byte cap with the verdict, the heading and every coverage line", () => {
    const long = Array.from({ length: 12 }, (unused, i) => ({
      chunk: { files: [`worker/jobs/long-name-${i}-a.mjs`, `worker/jobs/long-name-${i}-z.mjs`] },
      text:
        // Em dashes on purpose: the cap is BYTES, and a text whose characters
        // are all ASCII would not tell a byte cap from a character one.
        `${AUDIT_VERDICT_LINE}\n\n${"This chunk is fine — and the paragraph explaining why is long. ".repeat(30)}\n\n` +
        `${AUDIT_REMOVAL_HEADING}\n- worker/jobs/long-name-${i}-a.mjs: ${"a very wordy finding — ".repeat(12)}\n`,
    }));
    const big = composeChunkedAudit(long);
    const bytes = new TextEncoder().encode(big.text).length;
    expect(bytes).toBeGreaterThan(8 * 1024);
    expect(bytes).toBeGreaterThan(big.text.length);
    const kept = capUtf8(big.text, 8 * 1024);
    expect(GATE_VERDICT_RE.exec(kept)?.[1]).toBe("APPROVED");
    expect(/^[ \t]*REMOVAL CHECK:/im.test(kept)).toBe(true);
    for (let i = 1; i <= 12; i += 1) expect(kept).toContain(`chunk ${i}/12 `);
    // …and the bullets are still readable through the gate's own reader.
    expect(gateRemovalNotes(kept).length).toBeGreaterThan(0);
  });

  it("says `none` when no chunk found an unanswered addition", () => {
    const clean = composeChunkedAudit([
      { chunk: { files: ["a.ts"] }, text: `${AUDIT_VERDICT_LINE}\n\nfine\n\n${AUDIT_REMOVAL_HEADING} none\n` },
    ]);
    expect(clean.text).toContain(`${AUDIT_REMOVAL_HEADING} none`);
    expect(gateRemovalNotes(clean.text)).toEqual([]);
  });
});

describe("chunkSpan", () => {
  it("names one file as itself and a range as a range", () => {
    expect(chunkSpan(["a.ts"])).toBe("a.ts");
    expect(chunkSpan(["a.ts", "b.ts", "c.ts"])).toBe("a.ts…c.ts");
    expect(chunkSpan([])).toBe("(no file header)");
  });
});

// Each finding checks a CLAIM IN THE TEXT against the RUN RECORD. Each is tested
// both ways: a finding that cannot not-fire is a finding nobody can read.
describe("the four trace findings", () => {
  const full = { count: 3, read: 3, charsRead: 900, charsTotal: 900, truncatedChunks: 0, files: 3 };

  it("1 fires when the audit claims the tests pass and no green row exists", () => {
    const found = traceFindingsOf({
      text: "VERDICT: APPROVED\n\nThe tests pass on this branch.",
      chunks: full,
      testsPassed: false,
      sha: "a1b2c3d4",
    });
    expect(found.some((one) => one.startsWith("tests-claimed-not-run:"))).toBe(true);
  });

  it("1 does not fire when the row is green, nor when nothing was claimed", () => {
    expect(
      traceFindingsOf({ text: "VERDICT: APPROVED\n\nThe tests pass.", chunks: full, testsPassed: true }),
    ).toEqual([]);
    expect(
      traceFindingsOf({ text: "VERDICT: APPROVED\n\nIt does what it says.", chunks: full, testsPassed: false }),
    ).toEqual([]);
    // A gate nobody could read makes no claim either way.
    expect(
      traceFindingsOf({ text: "VERDICT: APPROVED\n\nThe tests pass.", chunks: full, testsPassed: null }),
    ).toEqual([]);
  });

  it("2 fires on a path the audit says it opened and the run never did", () => {
    const found = traceFindingsOf({
      text: "VERDICT: APPROVED\n\nI read worker/jobs/evals.mjs and it is unchanged here.",
      chunks: full,
      toolCalls: [{ name: "Read", path: "convex/http.ts" }],
    });
    expect(found).toEqual([
      "claimed-read-not-in-the-record: worker/jobs/evals.mjs is in no Read, Grep or Glob call of this audit's run",
    ]);
  });

  it("2 does not fire when the run really opened it, nor on a path merely named", () => {
    expect(
      traceFindingsOf({
        text: "VERDICT: APPROVED\n\nI read worker/jobs/evals.mjs and it is unchanged here.",
        chunks: full,
        toolCalls: [{ name: "Read", path: "/opt/tts/worker/jobs/evals.mjs" }],
      }),
    ).toEqual([]);
    // Named in the reason, not claimed as opened: the auditor saw it in the diff.
    expect(
      traceFindingsOf({
        text: "VERDICT: REFUSED\n\nworker/jobs/evals.mjs loses its null check.",
        chunks: full,
        toolCalls: [],
      }),
    ).toEqual([]);
  });

  it("3 fires on a partly-read diff and needs no run record to do it", () => {
    const found = traceFindingsOf({
      text: "VERDICT: APPROVED\n\nfine",
      chunks: { count: 12, read: 12, charsRead: 1_380_112, charsTotal: 1_519_624, truncatedChunks: 1, files: 126 },
    });
    expect(found).toEqual([
      "diff-not-fully-read: 12 of 12 chunks answered, 1380112 of 1519624 characters read",
    ]);
  });

  it("3 fires when a chunk never answered, even with every character read", () => {
    const found = traceFindingsOf({
      text: "VERDICT: UNAVAILABLE\n\nno",
      chunks: { count: 3, read: 2, charsRead: 900, charsTotal: 900, truncatedChunks: 0, files: 3 },
    });
    expect(found.some((one) => one.startsWith("diff-not-fully-read:"))).toBe(true);
  });

  it("3 does not fire when every chunk answered and every character was read", () => {
    expect(traceFindingsOf({ text: "VERDICT: APPROVED\n\nfine", chunks: full })).toEqual([]);
  });

  it("4 fires when a guard changed beside the code under it", () => {
    const found = traceFindingsOf({
      text: "VERDICT: APPROVED\n\nfine",
      chunks: full,
      files: ["worker/jobs/audit.mjs", "worker/jobs/audit.test.mjs"],
    });
    expect(found).toEqual([
      "guard-changed-with-what-it-guards: worker/jobs/audit.test.mjs changed in the same commit as worker/jobs/audit.mjs (worker/)",
    ]);
  });

  it("4 knows the check scripts and the gate itself as guards", () => {
    for (const guard of ["scripts/check-writing-standard.mjs", "convex/ttsMerge.ts", "worker/jobs/evals.mjs"]) {
      const top = guard.split("/")[0];
      const found = traceFindingsOf({
        text: "VERDICT: APPROVED\n\nfine",
        chunks: full,
        files: [guard, `${top}/ordinary.ts`],
      });
      expect(found.some((one) => one.startsWith("guard-changed-with-what-it-guards:"))).toBe(true);
    }
  });

  it("4 does not fire on a guard alone, on code alone, or across top-level directories", () => {
    const text = "VERDICT: APPROVED\n\nfine";
    expect(traceFindingsOf({ text, chunks: full, files: ["worker/jobs/audit.test.mjs"] })).toEqual([]);
    expect(traceFindingsOf({ text, chunks: full, files: ["worker/jobs/audit.mjs"] })).toEqual([]);
    expect(traceFindingsOf({ text, chunks: full, files: ["app/page.tsx", "worker/jobs/audit.test.mjs"] })).toEqual([]);
  });

  it("keeps at most twenty findings, at most three hundred characters each", () => {
    const many = Array.from({ length: 40 }, (unused, i) => `I read pkg${i}/src/file${i}.ts here.`).join("\n");
    const found = traceFindingsOf({ text: `VERDICT: APPROVED\n\n${many}`, chunks: full, toolCalls: [] });
    expect(found).toHaveLength(20);
    for (const one of found) expect(one.length).toBeLessThanOrEqual(300);
  });
});

describe("auditCommit", () => {
  it("posts the audit's own text and answers the recorded verdict", async () => {
    const { io: fake, posted } = io();
    const result = await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(result.verdict).toBe("APPROVED");
    expect(posted).toHaveLength(1);
    expect(posted[0].repo).toBe("tom.quest");
    expect(posted[0].text).toContain(AUDIT_VERDICT_LINE);
  });

  it("refuses an empty diff rather than approving nothing", async () => {
    const { io: fake, posted } = io({ run: () => "" });
    await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(posted[0].text).toContain("VERDICT: REFUSED");
    expect(posted[0].text).toContain("nothing to audit");
  });

  // A failed auditor is neither an approval nor a missing row: the gate has to
  // be able to tell "the audit ran and could not finish" from "no audit ran".
  it("records an auditor that could not run as UNAVAILABLE", async () => {
    const { io: fake, posted } = io({
      audit: () => {
        throw new Error("codex is over its weekly cap");
      },
    });
    await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(posted[0].text).toContain("VERDICT: UNAVAILABLE");
    expect(posted[0].text).toContain("weekly cap");
  });

  it("audits read-only — an auditor that can edit the tree it judges is not one", () => {
    expect(AUDIT_SANDBOX).toBe("read-only");
  });

  it("sends one prompt per chunk and posts the coverage record", async () => {
    // Big enough that the real AUDIT_CHUNK_MAX_CHARS gives one file per chunk,
    // so "one prompt per chunk" is tested against three prompts and not one.
    const big = Math.round(AUDIT_CHUNK_MAX_CHARS * 0.6);
    const diff = fileBlock("a/one.ts", big) + fileBlock("m/two.ts", big) + fileBlock("z/three.ts", big);
    const prompts = [];
    const { io: fake, posted } = io({
      run: () => diff,
      audit: (prompt) => {
        prompts.push(prompt);
        return `${AUDIT_VERDICT_LINE}\n\nfine`;
      },
    });
    const result = await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(result.chunks.count).toBe(3);
    expect(prompts).toHaveLength(3);
    expect(posted[0].chunks).toEqual({
      count: 3,
      read: 3,
      charsRead: diff.length,
      charsTotal: diff.length,
      truncatedChunks: 0,
      files: 3,
    });
    expect(prompts[0]).toContain(`of one change (3 files,`);
  });

  // "not asked" and "asked, no answer" must not print the same sentence.
  it("records an absent run record as a counted absence, not as silence", async () => {
    const { io: fake, posted } = io();
    await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(posted[0].trace.available).toBe(false);
    expect(typeof posted[0].trace.reason).toBe("string");
  });

  // THE ABSENCE SILENCES ONE FINDING, NOT FOUR. Finding 2 is the only one that
  // reads the run record. Gating the other three on the sweeper would put
  // `diff-not-fully-read` — the finding this round exists to produce — to sleep
  // exactly when the record is slowest.
  it("still reports the findings that need no run record when the trace never arrived", async () => {
    const text = `${AUDIT_VERDICT_LINE}

The tests pass. I opened worker/jobs/ghost.mjs to check.`;
    const { io: fake, posted } = io({
      // Two files under one top-level directory, one of them a guard, and a
      // diff far past twelve chunks so the coverage numbers cannot be whole.
      run: () => fileBlock("worker/jobs/audit.mjs", 130_000) + fileBlock("worker/jobs/audit.test.mjs", 130_000),
      audit: () => text,
      mergeGate: async () => ({ checks: [{ name: "tests", passed: false }] }),
      // no runTrace: the door is not in this tree at all
    });
    await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(posted[0].trace.available).toBe(false);
    const found = posted[0].traceFindings;
    expect(found.some((one) => one.startsWith("tests-claimed-not-run:"))).toBe(true);
    expect(found.some((one) => one.startsWith("diff-not-fully-read:"))).toBe(true);
    expect(found.some((one) => one.startsWith("guard-changed-with-what-it-guards:"))).toBe(true);
    // …and finding 2 alone is silent, because with no tool-call list every
    // claimed path would look unopened — a finding about the sweeper, not the
    // audit.
    expect(found.some((one) => one.startsWith("claimed-read-not-in-the-record:"))).toBe(false);
  });

  // A cut tool-call list makes finding 2 fire on a path that WAS opened and
  // fell past the door's 400-row cap — a false accusation against an honest
  // audit, which is the one failure this round cannot afford.
  it("keeps the trace available but silences the read-claim check when the door cut the list", async () => {
    const text = `${AUDIT_VERDICT_LINE}

I opened convex/ttsMerge.ts and it is fine.`;
    const { io: fake, posted } = io({
      audit: (prompt, receipt) => {
        receipt.runToken = "token-1";
        return text;
      },
      runTrace: async () => ({ runId: "run_1", turns: 9, tokens: 900, toolCalls: [], truncated: true }),
      mergeGate: async () => ({ checks: [{ name: "tests", passed: true }] }),
    });
    await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(posted[0].trace.available).toBe(true);
    expect(posted[0].trace.reason).toContain("the row cap cut the list");
    expect(posted[0].traceFindings.some((one) => one.startsWith("claimed-read-not-in-the-record:"))).toBe(false);
  });

  // "0 of 0 chunks, 0 of 0 characters" is not a coverage record, and it would
  // read in the gate's sentence as though the audit had answered.
  it("posts no chunks record at all when there was nothing to chunk", async () => {
    const { io: fake, posted } = io({ run: () => "" });
    await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect("chunks" in posted[0]).toBe(false);
    expect(posted[0].text).toContain("VERDICT: REFUSED");
  });

  it("records the findings when the trace did arrive", async () => {
    const { io: fake, posted } = io({
      run: () => fileBlock("worker/jobs/audit.mjs", 60) + fileBlock("worker/jobs/audit.test.mjs", 60),
      audit: (prompt, receipt) => {
        receipt.runToken = "token-1";
        return `${AUDIT_VERDICT_LINE}\n\nfine`;
      },
      runTrace: async () => ({ runId: "run_1", turns: 4, tokens: 900, toolCalls: [] }),
      mergeGate: async () => ({ checks: [{ name: "tests", passed: true }] }),
    });
    await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    // Two fields and no more: the Convex validator refuses an unknown one.
    expect(Object.keys(posted[0].trace).sort()).toEqual(["available", "reason"]);
    expect(posted[0].trace.available).toBe(true);
    expect(posted[0].trace.reason).toContain("1 of 1 audit run read");
    expect(posted[0].traceFindings).toEqual([
      "guard-changed-with-what-it-guards: worker/jobs/audit.test.mjs changed in the same commit as worker/jobs/audit.mjs (worker/)",
    ]);
  });
});

describe("isCodexCap", () => {
  it("knows the CLI's own cap wordings", () => {
    for (const text of [
      "You've hit your usage limit. Try again later.",
      "usage_limit_reached",
      "rate_limit_reached",
      "codex-run: codex exited 1 after 3s\nstream error: usage limit reached",
    ]) {
      expect(isCodexCap(new Error(text))).toBe(true);
    }
  });

  it("reads stderr and stdout as well as the message, which is where it lands", () => {
    const error = new Error("Command failed: tts-codex");
    error.stderr = "codex-run: codex exited 1\nYou've hit your usage limit. Try again later.\n";
    expect(isCodexCap(error)).toBe(true);
  });

  // A false positive downgrades the audit to the family that wrote the code,
  // so anything but the cap stays UNAVAILABLE.
  it("does not read an ordinary failure, or transient API weather, as the cap", () => {
    expect(isCodexCap(new Error("codex is over its weekly cap"))).toBe(false);
    expect(isCodexCap(new Error("spawn tts-codex ENOENT"))).toBe(false);
    expect(isCodexCap(new Error("overloaded_error"))).toBe(false);
    expect(isCodexCap(new Error("API rate limit exceeded (429)"))).toBe(false);
  });

  // codex-run prints the tail of the CLI's log, and the log echoes the prompt,
  // which is THE DIFF. A change that adds the cap's own words — this file is
  // one — must not read as a cap.
  it("does not read the echoed diff as a diagnosis", () => {
    const error = new Error("Command failed: tts-codex");
    error.stderr = [
      "codex-run: codex exited 1 after 3s",
      "+export const CODEX_CAP_RE = /hit your usage limit/i;",
      "-  \"You've hit your usage limit. Try again later.\",",
      " context line about a usage limit",
      "diff --git a/worker/jobs/audit.mjs b/worker/jobs/audit.mjs",
      "DIFF>>>",
    ].join("\n");
    expect(isCodexCap(error)).toBe(false);

    // …and still reads the CLI's own line, which sits beside those.
    error.stderr += "\nERROR: You've hit your usage limit. Visit ... or try again at Sep 17th.";
    expect(isCodexCap(error)).toBe(true);
  });
});

// Tom's standing rule for a capped box run is Opus (model-of-tom/agent-rules.md,
// Codex). The audit takes it too — and declares it, because an Opus audit of a
// Claude branch is the same family, which is the thing the check exists to
// avoid.
describe("the Codex cap's same-family fallback", () => {
  const capped = () => {
    throw new Error("You've hit your usage limit. Try again later.");
  };

  it("sends THE SAME prompt to Opus and records the row as a fallback", async () => {
    const seen = [];
    const { io: fake, posted } = io({
      audit: (prompt) => {
        seen.push(["codex", prompt]);
        return capped();
      },
      auditFallback: (prompt) => {
        seen.push(["opus", prompt]);
        return `${AUDIT_VERDICT_LINE}\n\nIt does what it says.`;
      },
    });
    const result = await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(result.verdict).toBe("APPROVED");
    expect(result.model).toBe(AUDIT_FALLBACK_MODEL);
    expect(result.fallback).toBe(AUDIT_FALLBACK_REASON);
    expect(seen.map((one) => one[0])).toEqual(["codex", "opus"]);
    expect(seen[1][1]).toBe(seen[0][1]);
    expect(posted[0].model).toBe(AUDIT_FALLBACK_MODEL);
    expect(posted[0].fallback).toBe(AUDIT_FALLBACK_REASON);
    expect(posted[0].text).toContain(AUDIT_VERDICT_LINE);
  });

  // ONE Opus chunk makes the whole row's fallback codex-cap: the gate's line
  // has to say a Claude model read part of this.
  it("declares the fallback when one chunk of several fell to it", async () => {
    // Big enough that the real AUDIT_CHUNK_MAX_CHARS gives one file per chunk.
    const big = Math.round(AUDIT_CHUNK_MAX_CHARS * 0.6);
    const diff = fileBlock("a/one.ts", big) + fileBlock("m/two.ts", big) + fileBlock("z/three.ts", big);
    let seen = 0;
    const { io: fake, posted } = io({
      run: () => diff,
      audit: () => {
        seen += 1;
        if (seen === 2) return capped();
        return `${AUDIT_VERDICT_LINE}\n\nfine`;
      },
      auditFallback: () => `${AUDIT_VERDICT_LINE}\n\nfine, read by Opus`,
    });
    const result = await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(result.chunks.count).toBe(3);
    expect(result.chunks.read).toBe(3);
    expect(result.verdict).toBe("APPROVED");
    expect(posted[0].fallback).toBe(AUDIT_FALLBACK_REASON);
    expect(posted[0].model).toBe(AUDIT_FALLBACK_MODEL);
  });

  it("does not weaken the audit on any failure but the cap", async () => {
    let fell = false;
    const { io: fake, posted } = io({
      audit: () => {
        throw new Error("spawn tts-codex ENOENT");
      },
      auditFallback: () => {
        fell = true;
        return `${AUDIT_VERDICT_LINE}\n\nfine`;
      },
    });
    await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(fell).toBe(false);
    expect(posted[0].text).toContain("VERDICT: UNAVAILABLE");
    expect(posted[0].model).toBe(AUDIT_MODEL);
    expect(posted[0].fallback).toBeUndefined();
  });

  it("is UNAVAILABLE when both families fail, and names both failures", async () => {
    const { io: fake, posted } = io({
      audit: capped,
      auditFallback: () => {
        throw new Error("claude: not logged in");
      },
    });
    await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(posted[0].text).toContain("VERDICT: UNAVAILABLE");
    expect(posted[0].text).toContain("usage limit");
    expect(posted[0].text).toContain("not logged in");
    expect(posted[0].model).toBe(AUDIT_MODEL);
    expect(posted[0].fallback).toBeUndefined();
  });

  // The first real fallback run died at runClaude's 8-turn default: the model
  // opened a few of the files the diff touched and hit max_turns_reached at
  // turn 9, so the row said UNAVAILABLE with the CAP's error on it.
  it("reads only, and gets enough turns to finish reading", () => {
    expect(AUDIT_FALLBACK_TOOLS).toEqual(["Read", "Grep", "Glob"]);
    expect(AUDIT_FALLBACK_MAX_TURNS).toBeGreaterThan(8);
  });

  it("records an ordinary Codex audit as Codex, with no fallback field", async () => {
    const { io: fake, posted } = io();
    const result = await auditCommit({ repo: "tom.quest", sha: "a1b2c3d", dir: "/w" }, fake);
    expect(result.fallback).toBe(null);
    expect(posted[0].model).toBe(AUDIT_MODEL);
    expect(posted[0].fallback).toBeUndefined();
  });
});
