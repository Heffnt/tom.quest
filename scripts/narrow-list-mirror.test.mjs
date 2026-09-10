import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { narrowListFailures } from "./narrow-list-mirror.mjs";

const shared = readFileSync("convex/ttsShared.ts", "utf8");
const sessionMjs = readFileSync("worker/session-host/session.mjs", "utf8");

describe("the narrow-list mirror (check-session-mirrors check 7)", () => {
  it("passes on the repository as it stands", () => {
    expect(narrowListFailures(shared, sessionMjs)).toEqual([]);
  });

  it("reads four items out of the one home", () => {
    // The count is Tom's list as of 2026-09-09: money, a message in his name,
    // deletion git cannot undo, a credential. It changes only when he says so.
    const drifted = sessionMjs.replace(
      /const NARROW_LIST_COMMANDS = \[\r?\n[\s\S]*?\n\];/,
      'const NARROW_LIST_COMMANDS = [\n  "spend money — a purchase, a subscription, a payment, or entering a payment method",\n];',
    );
    expect(narrowListFailures(shared, drifted)[0]).toContain(
      "ttsShared.ts has 4 items, session.mjs's mirror has 1",
    );
  });

  it("fails, naming both strings, when one command drifts on one side only", () => {
    const drifted = sessionMjs.replace(
      "read, print, move, or send a credential, key, token or password anywhere",
      "read or print a credential",
    );
    expect(drifted).not.toEqual(sessionMjs);
    const failures = narrowListFailures(shared, drifted);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("narrow list drifted at item 4");
    expect(failures[0]).toContain(
      "read, print, move, or send a credential, key, token or password anywhere",
    );
    expect(failures[0]).toContain("read or print a credential");
  });

  it("fails loudly when an entry's shape cannot be read, rather than dropping it", () => {
    // A command written across two lines parses as one fewer entry than the
    // block has lines — the count-vs-parsed assertion the other mirror checks
    // use, so an unreadable entry never vanishes from both sides.
    const drifted = sessionMjs.replace(
      '  "read, print, move, or send a credential, key, token or password anywhere",',
      '  "read, print, move, or send a credential,"\n    + " key, token or password anywhere",',
    );
    const failures = narrowListFailures(shared, drifted);
    expect(failures.join("\n")).toContain("unreadable entry shape");
  });

  it("names the missing side when a half is gone", () => {
    expect(narrowListFailures("", sessionMjs)).toEqual([
      "ttsShared.ts: NARROW_LIST not found",
    ]);
    expect(narrowListFailures(shared, "")).toEqual([
      "session.mjs: NARROW_LIST_COMMANDS not found",
    ]);
  });
});
