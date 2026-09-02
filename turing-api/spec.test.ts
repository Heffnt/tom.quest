import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// turing-api/spec.md cites repo files by path, and a cited path that does not
// exist is the failure this guards. The spec said twice that the /boolback page
// was "fed by scripts/boolback_export.py"; no such file has ever existed in this
// repo (the snapshot builder is turing-api/boolback_snapshot.py), and nothing
// caught it because prose is not compiled.
//
// witness: add `scripts/boolback_export.py` back to turing-api/spec.md in
// backticks and this test goes red.

const REPO_ROOT = join(__dirname, "..");
const SPEC = join(__dirname, "spec.md");

// Prefixes that name a path in THIS repo. Anything else in backticks is a
// cluster path, a booleanbackdoors path, a shell fragment, or prose.
const REPO_PREFIXES = ["app/", "convex/", "e2e/", "scripts/", "turing-api/", "vqc/", "worker/"];
// Resolved relative to turing-api/ rather than the repo root.
const LOCAL_PREFIXES = ["forge_scripts/"];

// A trailing line reference: `main.py:117`, `forge.py:348-354`, `route.ts:27`.
const LINE_REF = /:\d+(?:[-,]\d+)*$/;

function isCheckable(path: string): boolean {
  // secrets/ is committed only as *.example templates; secrets/next.env and
  // secrets/convex.env are correctly absent from a checkout.
  if (path.startsWith("secrets/")) return false;
  // Deployment files that exist only on the server: turing-api/.env and friends.
  const base = path.split("/").pop() ?? "";
  if (base.startsWith(".") && !base.endsWith(".example")) return false;
  return true;
}

/** Every inline-code span in the spec that names a file or directory in this repo. */
function citedRepoPaths(markdown: string): string[] {
  const spans = markdown.match(/`[^`\n]+`/g) ?? [];
  const found = new Set<string>();
  for (const span of spans) {
    let text = span.slice(1, -1).trim();
    if (/\s/.test(text)) continue; // a phrase, not a path
    text = text.replace(LINE_REF, "").replace(/[),.]+$/, "").replace(/\/$/, "");
    if (!text) continue;
    if (REPO_PREFIXES.some((p) => text.startsWith(p))) {
      if (isCheckable(text)) found.add(text);
    } else if (LOCAL_PREFIXES.some((p) => text.startsWith(p))) {
      if (isCheckable(text)) found.add(`turing-api/${text}`);
    }
  }
  return [...found].sort();
}

describe("turing-api/spec.md", () => {
  const markdown = readFileSync(SPEC, "utf8");

  it("cites at least a handful of repo paths (the extractor still works)", () => {
    expect(citedRepoPaths(markdown).length).toBeGreaterThan(10);
  });

  it("cites no file or directory that is absent from the repo", () => {
    const missing = citedRepoPaths(markdown).filter(
      (p) => !existsSync(join(REPO_ROOT, p)),
    );
    expect(missing, `spec.md cites paths that do not exist: ${missing.join(", ")}`).toEqual([]);
  });
});
