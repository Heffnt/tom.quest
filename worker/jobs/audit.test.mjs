import { describe, expect, it } from "vitest";

import {
  AUDIT_DIFF_MAX_CHARS,
  AUDIT_REMOVAL_HEADING,
  AUDIT_SANDBOX,
  AUDIT_VERDICT_LINE,
  auditCommit,
  auditPrompt,
  diffOf,
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
