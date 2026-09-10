// The repo-learning half: finding a session's archived transcript, reading
// the lines out of it that carry repo knowledge, keeping a rule out that is
// already a rule, and moving an entry from its proposed heading to the live
// one once the line is in the repository.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  REPO_ASSISTANT_TEXTS,
  REPO_LINE_CHARS,
  REPO_PROPOSALS_MAX,
  REPO_SESSIONS_MAX,
  REPO_SESSIONS_PER_REPO,
  appendProposalEntry,
  chooseSessions,
  dedupeProposals,
  dropProposal,
  evidenceLinesOf,
  normalizeSentence,
  priorProposalSentences,
  proposalHeading,
  proposalId,
  readRepoRules,
  reconcileApplied,
  renderProposalEntry,
  repoEvidencePath,
  repoLearningPrompt,
  repoRuleBullets,
  transcriptEvidence,
  transcriptPath,
} from "./learning-repo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = fs.readFileSync(path.join(here, "fixtures", "check-evidence.mjs"), "utf8");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "repo-learn-"));
}
function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

// ── The transcript ───────────────────────────────────────────────────────────
describe("transcriptPath", () => {
  const ID = "47f04bc9-1111-2222-3333-444444444444";

  it("finds both archive layouts and neither when there is nothing", () => {
    const dir = tmp();
    write(dir, `sessions/2026/09/09/claude-${ID}/session.jsonl.gz`, "x");
    expect(transcriptPath(dir, ID, "2026-09-09")).toBe(`sessions/2026/09/09/claude-${ID}/session.jsonl.gz`);

    const two = tmp();
    write(two, `sessions/2026/09/09/claude-${ID}/gmail-wpi/session.jsonl.gz`, "x");
    expect(transcriptPath(two, ID, "2026-09-09")).toBe(
      `sessions/2026/09/09/claude-${ID}/gmail-wpi/session.jsonl.gz`,
    );

    expect(transcriptPath(tmp(), ID, "2026-09-09")).toBeNull();
    expect(transcriptPath(dir, "", "2026-09-09")).toBeNull();
    expect(transcriptPath(dir, "../../etc/passwd", "2026-09-09")).toBeNull();
  });

  // A session that started before midnight is archived under the day its
  // first line carries, which can be either side of the day its row moved to
  // "ended".
  it("searches the day either side of the session's own", () => {
    const before = tmp();
    write(before, `sessions/2026/09/08/claude-${ID}/session.jsonl.gz`, "x");
    expect(transcriptPath(before, ID, "2026-09-09")).toBe(`sessions/2026/09/08/claude-${ID}/session.jsonl.gz`);
    const after = tmp();
    write(after, `sessions/2026/09/10/claude-${ID}/session.jsonl.gz`, "x");
    expect(transcriptPath(after, ID, "2026-09-09")).toBe(`sessions/2026/09/10/claude-${ID}/session.jsonl.gz`);
    // Two days away is not searched: that is a different session's archive.
    const far = tmp();
    write(far, `sessions/2026/09/11/claude-${ID}/session.jsonl.gz`, "x");
    expect(transcriptPath(far, ID, "2026-09-09")).toBeNull();
  });
});

describe("transcriptEvidence", () => {
  /** A transcript of `n` turns of noise around the lines that matter. */
  function fixture({ noise = 200, longText = false } = {}) {
    const lines = [];
    for (let i = 0; i < noise; i++) {
      lines.push(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: `turn ${i}` }] } }));
    }
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "pnpm check:agents" } },
            { type: "tool_use", name: "Read", input: { file_path: "/x" } },
          ],
        },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", is_error: true, content: "next dev failed: NEXT_PUBLIC_CONVEX_URL is missing\nstack line" },
            { type: "tool_result", is_error: false, content: "fine" },
          ],
        },
      }),
    );
    for (let i = 0; i < 10; i++) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: longText && i === 9 ? "L".repeat(32_000) : `assistant ${i}` }],
          },
        }),
      );
    }
    lines.push("not json at all");
    return zlib.gzipSync(Buffer.from(`${lines.join("\n")}\n`));
  }

  it("keeps the commands, the failures and the last assistant texts, and nothing else", () => {
    const out = transcriptEvidence(fixture()).split("\n");
    expect(out).toContain("ran: pnpm check:agents");
    expect(out.some((l) => l.startsWith("failed: next dev failed"))).toBe(true);
    // The failed result's FIRST line only.
    expect(out.join("\n")).not.toContain("stack line");
    // A result that did not fail is not evidence of anything.
    expect(out.join("\n")).not.toContain("fine");
    // A tool_use that is not Bash is not a command.
    expect(out.join("\n")).not.toContain("file_path");
    // The last six assistant texts, newest first.
    const said = out.filter((l) => l.startsWith("said: assistant"));
    expect(said).toHaveLength(REPO_ASSISTANT_TEXTS);
    expect(said[0]).toBe("said: assistant 9");
    expect(said.at(-1)).toBe("said: assistant 4");
  });

  it("clips a long block rather than dropping it, and stays under the cap", () => {
    const out = transcriptEvidence(fixture({ longText: true }), { chars: 2000 });
    expect(out.length).toBeLessThanOrEqual(2000);
    const clipped = out.split("\n").find((l) => l.startsWith("said: LLL"));
    expect(clipped).toBeDefined();
    expect(clipped.length).toBeLessThanOrEqual(REPO_LINE_CHARS + "said: ".length);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("returns nothing for bytes that are not a gzipped transcript", () => {
    expect(transcriptEvidence(Buffer.from("not gzip"))).toBe("");
  });
});

describe("chooseSessions", () => {
  it("takes the newest, and at most three from any one repository", () => {
    const sessions = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      repo: i % 2 === 0 ? "tom.quest" : `repo${i}`,
      at: i,
    }));
    const kept = chooseSessions(sessions);
    expect(kept).toHaveLength(REPO_SESSIONS_MAX);
    expect(kept[0].id).toBe("s19");
    expect(kept.filter((s) => s.repo === "tom.quest")).toHaveLength(REPO_SESSIONS_PER_REPO);
  });
});

// ── Two sentences that are the same rule ─────────────────────────────────────
describe("normalizeSentence", () => {
  it("collapses punctuation, quotes, backticks and the bullet marker", () => {
    const a = "- A worktree has no `.env.local`; copy it from the main checkout before `next dev`.";
    const b = 'A worktree has no ".env.local" — copy it from the main checkout before next dev';
    expect(normalizeSentence(a)).toBe(normalizeSentence(b));
    // A different word is a different rule.
    expect(normalizeSentence(a)).not.toBe(normalizeSentence(a.replace("copy", "move")));
    expect(normalizeSentence("  ")).toBe("");
  });
});

describe("dedupeProposals", () => {
  const proposal = (line, over = {}) => ({ repo: "tom.quest", file: "worker/AGENTS.md", section: "box", line, read: "read it", sources: ["47f04bc9"], ...over });

  it("drops a duplicate of a repo bullet, of an entry on record, and of a recent proposal", () => {
    const { kept, dropped } = dedupeProposals(
      [
        proposal("Copy `.env.local` into the worktree before `next dev`."),
        proposal("Never edit tts/snapshot by hand."),
        proposal("Run the migration before the deploy."),
        proposal("A new rule nothing knows yet."),
      ],
      {
        bullets: ["Copy .env.local into the worktree before next dev"],
        entryLines: ["Never edit `tts/snapshot` by hand!"],
        priorSentences: ["Run the migration before the deploy."],
      },
    );
    expect(kept.map((p) => p.line)).toEqual(["A new rule nothing knows yet."]);
    expect(dropped).toHaveLength(3);
    expect(dropped.every((d) => d.reason.startsWith("a duplicate"))).toBe(true);
  });

  it("drops a second copy of the same proposal within one night", () => {
    const { kept } = dedupeProposals([proposal("The same rule."), proposal("the same rule")], {});
    expect(kept).toHaveLength(1);
  });

  it("caps the night at five and counts the rest", () => {
    const nine = Array.from({ length: 9 }, (_, i) => proposal(`Rule number ${i}.`));
    const { kept, dropped } = dedupeProposals(nine, {});
    expect(kept).toHaveLength(REPO_PROPOSALS_MAX);
    expect(dropped).toHaveLength(4);
    expect(dropped.every((d) => d.reason.includes("cap"))).toBe(true);
  });
});

describe("priorProposalSentences", () => {
  it("looks back ninety nights and no further", () => {
    const rows = [
      { day: "2026-08-10", line: "thirty days old" },
      { day: "2026-06-01", line: "a hundred days old" },
      { data: { day: "2026-09-08", line: "yesterday, on the data field" } },
    ];
    expect(priorProposalSentences(rows, "2026-09-09")).toEqual([
      "thirty days old",
      "yesterday, on the data field",
    ]);
  });
});

// ── The evidence entry ───────────────────────────────────────────────────────
describe("the proposal's evidence entry", () => {
  const proposal = {
    repo: "tom.quest",
    file: "worker/AGENTS.md",
    section: "box",
    line: "A worktree has no `.env.local`; copy it from the main checkout before `next dev`.",
    read: "`next dev` failed in the worktree with a missing NEXT_PUBLIC_CONVEX_URL until the file was copied.",
    sources: ["47f04bc9"],
  };

  it("names its file and section, and says the line is not in the repository yet", () => {
    expect(proposalHeading("worker/AGENTS.md", "box", { proposed: true })).toBe("worker/AGENTS.md#box — proposed");
    expect(proposalHeading("worker/AGENTS.md", "box")).toBe("worker/AGENTS.md#box");
    expect(proposalHeading("AGENTS.md", "")).toBe("AGENTS.md");
    expect(repoEvidencePath("tom.quest")).toBe("model-of-tom/evidence/repos/tom.quest.md");
    expect(repoEvidencePath("../etc")).toBeNull();
  });

  it("renders as one entry with a read: field", () => {
    expect(renderProposalEntry(proposal, "2026-09-09").split("\n")).toEqual([
      "- line: A worktree has no `.env.local`; copy it from the main checkout before `next dev`.",
      "  read: 2026-09-09 · session 47f04bc9 · `next dev` failed in the worktree with a missing NEXT_PUBLIC_CONVEX_URL until the file was copied.",
    ]);
    // More than one session read it, and the entry says how many.
    expect(renderProposalEntry({ ...proposal, sources: ["47f04bc9", "8da7169a"] }, "2026-09-09")).toContain(
      "(2 sessions)",
    );
  });

  it("appends under an existing heading and creates a missing one", () => {
    const entry = renderProposalEntry(proposal, "2026-09-09");
    const fresh = appendProposalEntry("", "worker/AGENTS.md#box — proposed", entry);
    expect(fresh).toContain("## worker/AGENTS.md#box — proposed");
    expect(fresh).toContain("- line: A worktree");
    const again = appendProposalEntry(fresh, "worker/AGENTS.md#box — proposed", "- line: Another.\n  read: a · b · c");
    expect(again.match(/## worker\/AGENTS\.md#box — proposed/g)).toHaveLength(1);
    expect(again.indexOf("- line: Another.")).toBeGreaterThan(again.indexOf("- line: A worktree"));
  });

  it("gives its id the shape a reply of Tom's can name", () => {
    const id = proposalId(proposal.repo, proposal.file, proposal.section, proposal.line);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    // Two wordings of one rule are one proposal.
    expect(proposalId(proposal.repo, proposal.file, proposal.section, proposal.line.replace(/`/g, ""))).toBe(id);
  });
});

// ── What happens to a proposal ───────────────────────────────────────────────
describe("reconcileApplied", () => {
  const file = "worker/AGENTS.md";
  const before = [
    "Evidence for tom.quest.",
    "",
    "## worker/AGENTS.md#box — proposed",
    "",
    "- line: A worktree has no `.env.local`; copy it before `next dev`.",
    "  read: 2026-09-09 · session 47f04bc9 · it failed until the file was copied.",
    "",
  ].join("\n");

  it("moves the entry to the live heading and rewrites the line to what merged", () => {
    const out = reconcileApplied(before, {
      file,
      section: "box",
      line: "A worktree has no `.env.local`; copy it before `next dev`.",
      appliedLine: "A worktree has no `.env.local`: copy it from the main checkout before `next dev`.",
    });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("## worker/AGENTS.md#box\n");
    expect(out.text).not.toContain("— proposed\n\n- line:");
    expect(out.text).toContain("- line: A worktree has no `.env.local`: copy it from the main checkout before `next dev`.");
    // The read: field travels with it.
    expect(out.text).toContain("read: 2026-09-09 · session 47f04bc9 · it failed until the file was copied.");
    // Running it again is a no-op: the entry is already live.
    const twice = reconcileApplied(out.text, {
      file,
      section: "box",
      line: "A worktree has no `.env.local`; copy it before `next dev`.",
    });
    expect(twice).toMatchObject({ ok: false, moved: false });
    expect(twice.text).toBe(out.text);
  });
});

describe("dropProposal", () => {
  it("keeps the heading and writes why the rule is not a rule", () => {
    const before = [
      "Evidence for tom.quest.",
      "",
      "## worker/AGENTS.md#box — proposed",
      "",
      "- line: Always run the whole suite.",
      "  read: 2026-09-09 · session 47f04bc9 · the partial run missed it.",
      "",
    ].join("\n");
    const out = dropProposal(before, {
      file: "worker/AGENTS.md",
      section: "box",
      line: "Always run the whole suite.",
      day: "2026-09-10",
      reply: "no — the suite takes nine minutes",
    });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("## worker/AGENTS.md#box — proposed");
    expect(out.text).toContain("  dropped: 2026-09-10 · Tom's objection · no — the suite takes nine minutes");
    expect(dropProposal(before, { file: "x", section: "y", line: "z", day: "d", reply: "r" }).ok).toBe(false);
  });
});

describe("readRepoRules", () => {
  it("reads the root file and the nested ones, and says when there are none", () => {
    const dir = tmp();
    write(dir, "AGENTS.md", "# root\n\n- Write its name as tom.Quest.\n");
    write(dir, "worker/AGENTS.md", "# worker\n\n- The box runs plain Node.\n");
    write(dir, "convex/http/AGENTS.md", "# deep\n\n- Every route takes the worker key.\n");
    write(dir, "a/b/c/AGENTS.md", "# too deep\n\n- Never read.\n");
    write(dir, "node_modules/AGENTS.md", "# ignored\n");
    const { files, missing } = readRepoRules(dir);
    expect(missing).toBe(false);
    expect(files.map((f) => f.path).sort()).toEqual(["AGENTS.md", "convex/http/AGENTS.md", "worker/AGENTS.md"]);
    expect(repoRuleBullets(files)).toContain("The box runs plain Node.");
    expect(readRepoRules(path.join(dir, "nowhere"))).toEqual({ files: [], missing: true });
    expect(readRepoRules(null)).toEqual({ files: [], missing: true });
    expect(readRepoRules(tmp())).toEqual({ files: [], missing: true });
  });
});

describe("repoLearningPrompt", () => {
  it("ends with the UTC day, after the sessions, the files and what is on record", () => {
    const prompt = repoLearningPrompt([{ session: "47f04bc9" }], "=== AGENTS.md ===\nx", "- a line", "2026-09-09");
    expect(prompt.endsWith("Tonight is 2026-09-09 (UTC).")).toBe(true);
    expect(prompt.indexOf("\nSESSIONS\n")).toBeLessThan(prompt.indexOf("\nTHE FILES AS THEY STAND\n"));
    expect(prompt.indexOf("\nTHE FILES AS THEY STAND\n")).toBeLessThan(
      prompt.indexOf("\nPROPOSALS AND LINES ALREADY ON RECORD"),
    );
    expect(prompt).toContain("At most 5 proposals");
  });
});

// ── The gate ─────────────────────────────────────────────────────────────────
describe("what the step leaves against check-evidence.mjs", () => {
  it("passes with a proposed heading, a live one and a dropped entry", () => {
    const dir = tmp();
    write(dir, "scripts/check-evidence.mjs", CHECKER);
    for (const rel of ["agent-rules.md", "intent.md", "ground.md", "writing.md", "priorities.md", "schedule.md"]) {
      write(dir, `model-of-tom/${rel}`, `# ${rel}\n\n## Only\n\n`);
      write(dir, `model-of-tom/evidence/${rel}`, `# Evidence\n\n## Only\n\n`);
    }
    write(dir, "model-of-tom/areas/climbing.md", "## Current state\n\n");
    write(dir, "model-of-tom/evidence/areas/climbing.md", "# Evidence\n\n## Current state\n\n");

    let text = "Evidence for tom.quest.\n";
    text = appendProposalEntry(
      text,
      proposalHeading("worker/AGENTS.md", "box", { proposed: true }),
      renderProposalEntry(
        { line: "A worktree has no `.env.local`.", read: "it failed until it was copied.", sources: ["47f04bc9"] },
        "2026-09-09",
      ),
    );
    text = appendProposalEntry(
      text,
      proposalHeading("AGENTS.md", "style"),
      renderProposalEntry({ line: "Simple interfaces around deep modules.", read: "the source accounting.", sources: ["8da7169a"] }, "2026-09-09"),
    );
    text = dropProposal(text, {
      file: "worker/AGENTS.md",
      section: "box",
      line: "A worktree has no `.env.local`.",
      day: "2026-09-10",
      reply: "no",
    }).text;
    write(dir, "model-of-tom/evidence/repos/tom.quest.md", text);

    const out = execFileSync("node", ["scripts/check-evidence.mjs"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toContain("evidence check: ok");
    expect(out).toContain("2 repository entries");
    // The entry the checker read back is the one that was written.
    expect(evidenceLinesOf(text)).toEqual([
      "A worktree has no `.env.local`.",
      "Simple interfaces around deep modules.",
    ]);
  });
});
