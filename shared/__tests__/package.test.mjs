// shared/ is imported by three runtimes: Convex's default runtime, the Next.js
// site and plain Node on the Jarvis Box. None of them resolves a package or a
// builtin for these files the same way, so the rule is that a module here
// reaches only its own siblings, and package.json names every module.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SHARED = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(SHARED, "package.json"), "utf8"));
const modules = readdirSync(SHARED)
  .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
  .sort();

// Static imports and re-exports, across lines, plus `import "x"` and import().
const SPECIFIERS = [
  /(?:^|\n)[ \t]*(?:import|export)\b[^;'"`]*?\bfrom[ \t\r\n]*["']([^"']+)["']/g,
  /(?:^|\n)[ \t]*import[ \t]+["']([^"']+)["']/g,
  /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
];
const specifiersOf = (text) => SPECIFIERS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]));

describe("shared/package.json", () => {
  it("exports every module in shared/ and nothing else", () => {
    const exported = Object.keys(pkg.exports).filter((key) => key !== "./package.json").sort();
    expect(exported).toEqual(modules.map((name) => `./${name}`));
    for (const key of exported) expect(pkg.exports[key]).toBe(key);
  });

  it("declares no dependency and no script", () => {
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "scripts"]) {
      expect(pkg[field]).toBeUndefined();
    }
    expect(pkg.type).toBe("module");
  });
});

describe("shared/*.mjs imports", () => {
  it("imports only siblings that exist", () => {
    for (const name of modules) {
      const text = readFileSync(join(SHARED, name), "utf8");
      for (const specifier of specifiersOf(text)) {
        expect(specifier, `${name} imports ${specifier}`).toMatch(/^\.\/[\w.-]+\.mjs$/);
        expect(modules, `${name} imports ${specifier}, which is not in shared/`).toContain(specifier.slice(2));
      }
    }
  });
});
