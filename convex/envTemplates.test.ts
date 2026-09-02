// Guardrail: the Convex-side env template and the README's Convex-side table
// are two homes for one list, and they drifted apart on their own — the
// template carried 19 variables while the table listed 4, and
// SESSIONS_WORKER_KEY (which convex/http.ts requires for /sessions/poll and
// /sessions/ingest) was in neither. A missing template line is not a loud
// failure: keyAuth answers 503, so a deployment rebuilt from the template
// simply has no session-host channel, and nothing says why.
//
// The tie is deliberately template <-> README only. It does NOT yet assert
// that every variable Convex code reads is declared: TOM_USERNAME
// (convex/users.ts) is read at runtime and declared in no template, and
// closing that hole is a separate change.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

const template = readFileSync(
  join(ROOT, "secrets", "convex.env.example"),
  "utf8",
);
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

// Every assignment line, ignoring comments (which carry example values like
// `# TTS_ICS_FEEDS=[{...}]` and must not count as declarations).
function templateVars(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

// The rows of the "### Convex-side" table, first cell only. A cell may name
// several variables, either as separate `code` spans or with a brace group
// (`GOOGLE_CALENDAR_{CLIENT_ID,REFRESH_TOKEN}`), which is expanded here.
function readmeVars(text: string): string[] {
  const start = text.indexOf("### Convex-side");
  expect(start, "README has no '### Convex-side' section").toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);

  const names: string[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const span of firstCell.matchAll(/`([^`]+)`/g)) {
      const braces = /^([A-Z][A-Z0-9_]*)\{([^}]+)\}$/.exec(span[1]);
      if (braces) {
        for (const suffix of braces[2].split(","))
          names.push(braces[1] + suffix.trim());
      } else if (/^[A-Z][A-Z0-9_]*$/.test(span[1])) {
        names.push(span[1]);
      }
    }
  }
  return names;
}

describe("Convex env template and README table", () => {
  const inTemplate = templateVars(template);
  const inReadme = readmeVars(readme);

  it("parses a non-empty list from each side", () => {
    // Without this, a regex that stopped matching would make the comparison
    // below pass over two empty sets.
    expect(inTemplate.length).toBeGreaterThan(10);
    expect(inReadme.length).toBeGreaterThan(10);
  });

  it("declares each variable exactly once per side", () => {
    expect([...new Set(inTemplate)].sort()).toEqual([...inTemplate].sort());
    expect([...new Set(inReadme)].sort()).toEqual([...inReadme].sort());
  });

  it("lists the same variables on both sides", () => {
    // Sorted set equality, so the failure message names the drifted variable.
    expect([...new Set(inReadme)].sort()).toEqual(
      [...new Set(inTemplate)].sort(),
    );
  });

  it("carries the keys convex/http.ts key-auth requires", () => {
    // witness: delete the SESSIONS_WORKER_KEY line from the template and this
    // fails, where the running deployment only answers 503.
    for (const key of ["TTS_WORKER_KEY", "SESSIONS_WORKER_KEY", "POOL_AGENT_KEY"]) {
      expect(inTemplate).toContain(key);
      expect(inReadme).toContain(key);
    }
  });
});
