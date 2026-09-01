import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as lib from "./tts-code-lib.mjs";

// Regression guard for a name collision that is invisible from inside this
// repo. The code-todo jobs (brief-code-todos, apply-rulings, execute-approved)
// read and edit a file at the literal path "vqc/todos.yaml" — but always
// inside a clone of the ComplexMultiTrigger (CMT) repo, never here. tom.quest
// ALSO has a vqc/todos.yaml, at the same literal path, and the two files
// disagree about what closing a todo means:
//
//   CMT       closes by moving the entry below a banner line
//             ("# --- closed todos"), guarded by a pytest module.
//   tom.quest closes in place with `status` + `resolution`, guarded by
//             vqc/todos.test.ts under vitest. It has no banner at all.
//
// So an unprefixed `TODOS_PATH` read in a tom.quest checkout looks like it
// names this repo's registry, and any edit written on that reading would be
// wrong about the closure rule. The fix is the CMT_ prefix; this test keeps it.

const REPO_ROOT = join(import.meta.dirname, "..", "..");

describe("tts-code-lib CMT-scoped constants", () => {
  it("exports the todos constants only under CMT_-prefixed names", () => {
    expect(lib.CMT_TODOS_PATH).toBe("vqc/todos.yaml");
    expect(lib.CMT_TODOS_GUARD_TEST).toBe("tests/guards/test_bb_todos.py");
    expect(lib.CMT_CLOSED_BANNER_PREFIX).toBe("# --- closed todos");
    // Unprefixed aliases would reintroduce the ambiguity at every import site.
    expect(Object.keys(lib)).not.toContain("TODOS_PATH");
    expect(Object.keys(lib)).not.toContain("TODOS_GUARD_TEST");
    expect(Object.keys(lib)).not.toContain("CLOSED_BANNER_PREFIX");
  });

  it("names a guard test that belongs to CMT, not to this repo", () => {
    // CMT's guard is python/pytest and is not a file here...
    expect(lib.CMT_TODOS_GUARD_TEST.endsWith(".py")).toBe(true);
    expect(existsSync(join(REPO_ROOT, lib.CMT_TODOS_GUARD_TEST))).toBe(false);
    // ...while tom.quest's guard for its own registry is the vitest module.
    expect(existsSync(join(REPO_ROOT, "vqc/todos.test.ts"))).toBe(true);
  });

  it("names a closed-todos banner that this repo's todos.yaml does not use", () => {
    const ours = readFileSync(join(REPO_ROOT, lib.CMT_TODOS_PATH), "utf8");
    const banner = ours
      .split("\n")
      .some((line) => line.startsWith(lib.CMT_CLOSED_BANNER_PREFIX));
    expect(banner).toBe(false);
  });
});
