import path from "path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/** Lint a snippet through the repo's real eslint.config.mjs.
 *
 *  `lintText` does not read the disk; `filePath` only tells ESLint which
 *  config entries and ignore rules apply, so the fixture path names a file
 *  that need not exist. It sits under worker/ because that is where the
 *  deliberate discards this exemption exists for actually live, and because
 *  worker/ is not in the config's ignore list. */
async function warningsFor(code, fixture = "worker/eslint-fixture.mjs") {
  const eslint = new ESLint({ cwd: path.resolve(import.meta.dirname) });
  const [result] = await eslint.lintText(code, {
    filePath: path.resolve(import.meta.dirname, fixture),
  });
  return result.messages
    .filter((m) => m.ruleId === "@typescript-eslint/no-unused-vars")
    .map((m) => m.message);
}

describe("no-unused-vars and the underscore convention", () => {
  // The secret scrub in worker/session-host/session.mjs strips secrets out of
  // a child process env by destructuring them into names it never reads. Those
  // eleven bindings are deliberate. Before 2026-09-02 each one emitted a
  // warning on every `pnpm lint`, which is what made a real finding arrive
  // among entries everyone had learned to scroll past.
  it("does not report a discarded binding whose name starts with an underscore", async () => {
    const scrub = `
      const { SECRET_KEY: _secret, ...rest } = process.env;
      export default rest;
    `;
    expect(await warningsFor(scrub)).toEqual([]);
  });

  it("still reports a discarded binding without the underscore", async () => {
    const scrub = `
      const { SECRET_KEY: secret, ...rest } = process.env;
      export default rest;
    `;
    const warnings = await warningsFor(scrub);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'secret' is assigned a value but never used");
  });

  // The underscore has to mean the same thing in every position a name can be
  // bound, or it is not a convention.
  it("does not report an unused parameter or caught error named with an underscore", async () => {
    const both = `
      export function handler(_event) {
        try {
          return 1;
        } catch (_error) {
          return 0;
        }
      }
    `;
    expect(await warningsFor(both)).toEqual([]);
  });
});
