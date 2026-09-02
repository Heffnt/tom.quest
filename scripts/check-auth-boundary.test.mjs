import { describe, expect, it } from "vitest";

import { RULES, violationsFor } from "./check-auth-boundary.mjs";

const ELSEWHERE = "app/components/login-modal.tsx";

function names(violations) {
  return violations.map((violation) => violation.rule);
}

describe("username normalization is fenced into convex/authUsername.ts", () => {
  it("fails a hand-written strip anywhere else", () => {
    const source = `const n = username.toLowerCase().replace(/[^a-z0-9]/g, "");`;
    expect(names(violationsFor(ELSEWHERE, source))).toEqual([
      "username normalization",
    ]);
  });

  it("fails the strip written on its own continuation line", () => {
    // The shape convex/users.ts used: the two halves split across lines, so a
    // rule that only recognised them together would have missed this copy.
    const source = ["const n = (process.env.TOM_USERNAME ?? 'tom')", "  .toLowerCase()", '  .replace(/[^a-z0-9]/g, "");'].join("\n");
    expect(names(violationsFor(ELSEWHERE, source))).toEqual([
      "username normalization",
    ]);
  });

  it("fails a hand-built account address", () => {
    const source = 'q.eq("email", `${normalized}@tom.quest`)';
    expect(names(violationsFor(ELSEWHERE, source))).toEqual([
      "username normalization",
    ]);
  });

  it("passes the file that is allowed to hold the rule", () => {
    const source = `return username.toLowerCase().replace(/[^a-z0-9]/g, "");`;
    expect(violationsFor("convex/authUsername.ts", source)).toEqual([]);
  });

  it("passes a call to the shared function", () => {
    const source = `const email = accountEmail(username);`;
    expect(violationsFor(ELSEWHERE, source)).toEqual([]);
  });
});

describe("admin role derivation stays fenced", () => {
  it("fails an inline role comparison outside the boundary", () => {
    const source = `const isAdmin = role === "admin" || role === "tom";`;
    expect(names(violationsFor("app/turing/turing-client.tsx", source))).toEqual([
      "admin role derivation",
    ]);
  });

  it("passes inside convex/authRoles.ts", () => {
    const source = `isAdmin: resolved === "admin" || resolved === "tom",`;
    expect(violationsFor("convex/authRoles.ts", source)).toEqual([]);
  });
});

describe("comments may describe a rule without breaking the build", () => {
  // The narrowing this needed: convex/users.ts explains, in prose, that the
  // email index holds `${username}@tom.quest`. Describing the rule is not a
  // second copy of it, and failing the build for the explanation would teach
  // people to delete their explanations.
  it("ignores the rule quoted in a line comment", () => {
    const source = "// the index holds `${username}@tom.quest`, derived at sign-up";
    expect(violationsFor(ELSEWHERE, source)).toEqual([]);
  });

  it("ignores the rule quoted in a block comment body", () => {
    const source = ' * `.replace(/[^a-z0-9]/g, "")` is the strip half.';
    expect(violationsFor(ELSEWHERE, source)).toEqual([]);
  });

  it("still fails code that carries a trailing comment", () => {
    const source = 'const n = s.replace(/[^a-z0-9]/g, ""); // fine, surely';
    expect(names(violationsFor(ELSEWHERE, source))).toEqual([
      "username normalization",
    ]);
  });
});

describe("every rule names the function that replaces it", () => {
  it("has a remedy and at least one allowed file", () => {
    for (const rule of RULES) {
      expect(rule.remedy, rule.name).toBeTruthy();
      expect(rule.allowed.length, rule.name).toBeGreaterThan(0);
    }
  });
});
