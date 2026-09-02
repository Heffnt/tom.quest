import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The env templates are the repo's account of what the deployments need.
// Nothing verified that account against the code, so it drifted in both
// directions at once: secrets/next.env.example declared
// NEXT_PUBLIC_CONVEX_SITE_URL, which no file reads, while TOM_USERNAME — read
// by convex/users.ts — was declared nowhere. These two guards close the drift
// that a reader can check mechanically.
//
// witness 1: add `SOME_UNREAD_VAR=` to either .example file and the first test
// goes red.
// witness 2: change `TOM_USERNAME=tom` to a bare `TOM_USERNAME=` in
// secrets/convex.env.example and the second test goes red.

const ROOT = resolve(__dirname, "..");

const TEMPLATES = [
  "secrets/next.env.example",
  "secrets/convex.env.example",
] as const;

// Vars that are real but that no file in this repo mentions, because their
// reader lives outside it. Each entry names that reader, so an addition here
// is a claim someone can check rather than a silent exemption.
const EXTERNAL_READERS: Record<string, string> = {
  SENTRY_AUTH_TOKEN:
    "read by @sentry/nextjs's build-time source-map upload plugin, from the environment, at `next build`",
  JWT_PRIVATE_KEY:
    "read by @convex-dev/auth inside the Convex deployment when it signs a session token",
  JWKS: "read by @convex-dev/auth inside the Convex deployment when it verifies a session token",
  SITE_URL:
    "read by @convex-dev/auth as `requireEnv(\"SITE_URL\")` in dist/server/implementation/redirects.js — the base URL a sign-in redirect and a magic link are allowed to point at",
};

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".py"];
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  ".claude",
  ".vercel",
  "_generated",
]);
// This file names vars in EXTERNAL_READERS; counting itself as a reader would
// make every allowlist entry self-justifying.
const SELF = "scripts/env-templates.test.ts";

type Declaration = { name: string; value: string; commented: boolean; file: string };

/**
 * Every `NAME=value` line of a template, including the `# NAME=` lines that
 * declare an optional var. A commented line means "this deployment may leave
 * the var unset", which is a different claim from "set it to nothing".
 */
function readTemplate(file: string): Declaration[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const out: Declaration[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const commented = line.startsWith("#");
    const body = commented ? line.replace(/^#\s*/, "") : line;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(body);
    if (!match) continue;
    out.push({ name: match[1], value: match[2], commented, file });
  }
  return out;
}

// withFileTypes rather than statSync: a checkout can carry a symlink whose
// target is absent (.cursor/rules/00-global.mdc points outside the repo), and
// stat-ing one throws. A dirent reports such an entry as neither file nor
// directory, so it is skipped instead of killing the scan.
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    if (relative(ROOT, full) === SELF) continue;
    acc.push(full);
  }
  return acc;
}

const declarations = TEMPLATES.flatMap(readTemplate);
const corpus = sourceFiles(ROOT)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

describe("secrets/*.env.example", () => {
  it("declares no variable that nothing reads", () => {
    expect(declarations.length).toBeGreaterThan(0);
    const orphans = declarations
      .filter((d) => !(d.name in EXTERNAL_READERS))
      .filter((d) => !new RegExp(`\\b${d.name}\\b`).test(corpus))
      .map((d) => `${d.file}: ${d.name}`);
    expect(
      orphans,
      `declared but read by no source file. Either delete the line, or add the ` +
        `var to EXTERNAL_READERS in ${SELF} naming the reader outside this repo.`,
    ).toEqual([]);
  });

  it("spells out the default of every variable read through `?? \"...\"`", () => {
    // `??` falls back on undefined, never on "". A var read that way is safe
    // when ABSENT and broken when EMPTY, so a bare `NAME=` line in a template
    // that gets copied and pushed verbatim is the one shape that breaks it.
    const withDefaults = new Map<string, string>();
    const pattern = /process\.env\.([A-Z][A-Z0-9_]*)\s*\?\?\s*"([^"]*)"/g;
    for (const match of corpus.matchAll(pattern)) {
      withDefaults.set(match[1], match[2]);
    }
    expect(withDefaults.size).toBeGreaterThan(0);

    const wrong = declarations
      .filter((d) => !d.commented && withDefaults.has(d.name))
      .filter((d) => d.value !== withDefaults.get(d.name))
      .map(
        (d) =>
          `${d.file}: ${d.name}=${d.value || "(empty)"} but the code default is ` +
          `"${withDefaults.get(d.name)}"`,
      );
    expect(
      wrong,
      "an uncommented template line must carry the same value the code falls " +
        "back to, or be commented out so the var is genuinely absent.",
    ).toEqual([]);
  });
});
