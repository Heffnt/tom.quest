import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODE_REPOS,
  closeEntryText,
  findEntryBlock,
  isOpenEntry,
  repoConfig,
} from "./tts-code-lib.mjs";

// Guards for the code-todo loop's repo coverage and its text surgery.
//
// THE BUG THIS EXISTS FOR: convex/ttsSync.ts mirrored two repos' vqc/todos.yaml
// registries into Convex while the worker's briefing job only ever briefed one
// of them. An unbriefed mirror row gets no ruling card in the UI, and
// worker/jobs/form-batches.mjs drops every unbriefed code todo from the
// batchable set — so the uncovered repo's todos were invisible, silently and
// permanently. The first test below fails the moment the two lists diverge
// again in either direction.

type RepoConfig = {
  repo: string;
  defaultBranch: string;
  todosPath: string;
  closureStyle: string;
  guardCommand: string[] | null;
  pushMode: string;
  testCommand: string;
  handoffDir: string;
};

const REPOS = CODE_REPOS as unknown as Record<string, RepoConfig>;
const REPO_ROOT = join(__dirname, "..", "..");

// The Convex mirror's source list, read as TEXT. Importing convex/ttsSync.ts
// would drag in the Convex server runtime for a two-field literal; the worker
// box cannot import it at all (only worker/ is deployed there, and Node does
// not load .ts), which is exactly why the two lists can drift.
function mirrorSources(): { repo: string; branch: string }[] {
  const src = readFileSync(join(REPO_ROOT, "convex", "ttsSync.ts"), "utf8");
  const block = src.match(/const MIRROR_SOURCES = \[([\s\S]*?)\];/);
  expect(block, "MIRROR_SOURCES literal not found in convex/ttsSync.ts").not.toBeNull();
  const body = block![1];
  const entries = [
    ...body.matchAll(/\{\s*repo:\s*"([^"]+)",\s*branch:\s*"([^"]+)"\s*\}/g),
  ].map((m) => ({ repo: m[1], branch: m[2] }));
  // Count the literal's braces independently, so an entry whose shape the
  // regex cannot read fails loudly instead of vanishing from the comparison.
  expect(entries.length, "unreadable MIRROR_SOURCES entry shape").toBe(
    (body.match(/\{/g) ?? []).length,
  );
  return entries;
}

describe("governed-repo coverage", () => {
  // witness: delete the "tom.quest" entry from CODE_REPOS (or add a third repo
  // to MIRROR_SOURCES without adding it here) and this test goes red.
  it("covers exactly the repos the Convex mirror ingests, on the same branch", () => {
    const mirrored = mirrorSources()
      .map((s) => `${s.repo}@${s.branch}`)
      .sort();
    const covered = Object.values(REPOS)
      .map((c) => `${c.repo}@${c.defaultBranch}`)
      .sort();
    expect(covered).toEqual(mirrored);
  });

  it("keys the registry by each config's own repo name", () => {
    for (const [key, cfg] of Object.entries(REPOS)) expect(cfg.repo).toBe(key);
    expect(repoConfig("nope")).toBeNull();
  });

  // A repo whose own todos guard the box cannot run has no red-before-permanent
  // check of its own, so its rulings must land as a pull request where CI can
  // run that guard before Tom merges.
  it("sends a repo with no runnable guard through a pull request", () => {
    for (const cfg of Object.values(REPOS)) {
      if (cfg.guardCommand === null) expect(cfg.pushMode).toBe("pull-request");
      expect(["direct", "pull-request"]).toContain(cfg.pushMode);
      expect(["banner", "in-place"]).toContain(cfg.closureStyle);
    }
  });

  // The one governed repo whose registry lives in THIS tree: its declared
  // paths must be real, or every job briefing it fails on the first read.
  it("names paths that exist in this repo", () => {
    const cfg = REPOS["tom.quest"];
    expect(readFileSync(join(REPO_ROOT, cfg.todosPath), "utf8").length).toBeGreaterThan(0);
  });
});

describe("isOpenEntry", () => {
  // The two closure conventions, one predicate — and it must agree with the
  // Convex mirror's, or the UI offers rulings on entries no job will brief.
  it("reads both conventions", () => {
    expect(isOpenEntry({ id: "a", status: "active" })).toBe(true);
    expect(isOpenEntry({ id: "a" })).toBe(true);
    expect(isOpenEntry({ id: "a", closed: "2026-01-01" })).toBe(false);
    expect(isOpenEntry({ id: "a", status: "archived" })).toBe(false);
    expect(isOpenEntry({ id: "a", status: "done" })).toBe(false);
    expect(isOpenEntry({ id: "a", status: "waiting" })).toBe(true);
  });
});

const BANNER_FILE = [
  "- id: alpha",
  "  tier: R",
  "  created: 2026-01-01",
  "  statement: first",
  "",
  "- id: beta",
  "  tier: C",
  "  created: 2026-01-02",
  "  statement: second",
  "",
  "# --- closed todos below ---",
  "",
].join("\n");

const IN_PLACE_FILE = [
  "- id: alpha",
  "  readiness: unprepared",
  "  status: active",
  "  created: 2026-01-01",
  "  statement: first",
  "",
  "- id: beta",
  "  readiness: unprepared",
  "  status: active",
  "  created: 2026-01-02",
  "  statement: second",
  "",
].join("\n");

describe("closeEntryText", () => {
  it("moves a banner-style entry below the banner with closed + resolution", () => {
    const cfg = REPOS.ComplexMultiTrigger;
    const out = closeEntryText(BANNER_FILE, cfg, {
      id: "alpha",
      resolution: "done by hand",
      today: "2026-03-04",
    });
    expect(out.ok).toBe(true);
    const lines = out.text!.split("\n");
    const bannerAt = lines.findIndex((l: string) => l.startsWith("# --- closed todos"));
    const alphaAt = lines.findIndex((l: string) => l === "- id: alpha");
    expect(alphaAt).toBeGreaterThan(bannerAt);
    expect(out.text).toContain("  closed: 2026-03-04");
    expect(out.text).toContain("  resolution: >-");
    expect(out.text).toContain("done by hand");
    // The other entry is untouched and still on the live surface.
    expect(lines.findIndex((l: string) => l === "- id: beta")).toBeLessThan(bannerAt);
  });

  // witness: change tom.quest's closureStyle to "banner" and this goes red —
  // its registry has no banner to move an entry below.
  it("closes an in-place entry where it stands, by status", () => {
    const cfg = REPOS["tom.quest"];
    const out = closeEntryText(IN_PLACE_FILE, cfg, {
      id: "beta",
      resolution: "superseded",
      today: "2026-03-04",
    });
    expect(out.ok).toBe(true);
    const lines = out.text!.split("\n");
    expect(lines.indexOf("- id: alpha")).toBeLessThan(lines.indexOf("- id: beta"));
    expect(out.text).toContain("  status: archived");
    expect(out.text).toContain("superseded");
    expect(out.text).not.toContain("  closed:");
    // alpha keeps its own status.
    const alphaBlock = findEntryBlock(out.text!, "alpha")!.block;
    expect(alphaBlock).toContain("  status: active");
    expect(alphaBlock).not.toContain("resolution");
  });

  it("reports an already-closed entry as a no-op, not a failure", () => {
    const closed = closeEntryText(IN_PLACE_FILE, REPOS["tom.quest"], {
      id: "beta",
      resolution: "superseded",
      today: "2026-03-04",
    }).text!;
    const again = closeEntryText(closed, REPOS["tom.quest"], {
      id: "beta",
      resolution: "superseded",
      today: "2026-03-05",
    });
    expect(again.ok).toBe(false);
    expect(again.already).toBe(true);
  });

  it("reports a missing entry by name", () => {
    const out = closeEntryText(IN_PLACE_FILE, REPOS["tom.quest"], {
      id: "gamma",
      resolution: "x",
      today: "2026-03-04",
    });
    expect(out.ok).toBe(false);
    expect(out.already).toBeUndefined();
    expect(out.reason).toContain("gamma");
  });
});
