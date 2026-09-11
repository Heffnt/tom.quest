import { describe, expect, it } from "vitest";

import {
  AUDIT_DIFF_MAX_CHARS,
  AUDIT_FALLBACK_MAX_TURNS,
  AUDIT_FALLBACK_MODEL,
  AUDIT_FALLBACK_TOOLS,
  AUDIT_FALLBACK_REASON,
  AUDIT_MODEL,
  AUDIT_SANDBOX,
  AUDIT_VERDICT_LINE,
  auditCommit,
  auditPrompt,
  diffOf,
  isCodexCap,
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

  it("says so when the diff was cut", () => {
    const cut = auditPrompt({ repo: "r", sha: "s", base: null, subject: "", diff: "d", truncated: true });
    expect(cut).toContain("THE DIFF BELOW IS CUT");
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

  it("cuts a change larger than the audit takes, and says it cut it", () => {
    const huge = "x".repeat(AUDIT_DIFF_MAX_CHARS + 10);
    const answer = diffOf("/w", "sha", null, () => huge);
    expect(answer.truncated).toBe(true);
    expect(answer.diff).toHaveLength(AUDIT_DIFF_MAX_CHARS);
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
