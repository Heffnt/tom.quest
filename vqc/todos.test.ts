import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

// Shape guard for vqc/todos.yaml (the contract is documented in the file's
// header). Runs in CI via test:turing — a malformed entry breaks the build,
// exactly as in the CMT repo this convention comes from.

type Entry = {
  id: string;
  readiness: string;
  status: string;
  created: string;
  cites: string[];
  statement: string;
  completion_condition: string;
  plan?: string;
  resolution?: string;
};

const READINESS = ["unprepared", "preparing", "ready-for-tom"];
const STATUS = ["active", "waiting", "archived", "done"];

// The cite resolution set (vqc/adoption.md): constitution article ids,
// dts-spec section refs, or open ledger entry ids.
const ARTICLE_OR_SPEC = /^(A\d+|C[1-9]|D\d+|dts-spec:\d+(\.\d+)?)$/;

function openLedgerIds(): Set<string> {
  const raw = readFileSync(join(__dirname, "ledger.yaml"), "utf8");
  const parsed = loadYaml(raw) as { id: string }[];
  return new Set(parsed.map((e) => e.id));
}

function loadEntries(): Entry[] {
  const raw = readFileSync(join(__dirname, "todos.yaml"), "utf8");
  const parsed = loadYaml(raw);
  expect(Array.isArray(parsed)).toBe(true);
  return parsed as Entry[];
}

describe("vqc/todos.yaml", () => {
  it("is a non-empty list of well-formed entries", () => {
    const entries = loadEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.id, JSON.stringify(entry)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(READINESS, entry.id).toContain(entry.readiness);
      expect(STATUS, entry.id).toContain(entry.status);
      expect(entry.created, entry.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.statement?.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.completion_condition?.trim().length, entry.id).toBeGreaterThan(0);
    }
  });

  it("has unique ids (never reused, open or closed)", () => {
    const ids = loadEntries().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // witness: change any entry's `cites` to [] (or to a bogus id like
  // "X99") in vqc/todos.yaml and this test goes red.
  it("requires resolvable, non-empty cites (a todo cites, never duplicates)", () => {
    const ledgerIds = openLedgerIds();
    for (const entry of loadEntries()) {
      expect(Array.isArray(entry.cites) && entry.cites.length > 0, entry.id).toBe(
        true,
      );
      for (const cite of entry.cites) {
        expect(
          ARTICLE_OR_SPEC.test(cite) || ledgerIds.has(cite),
          `${entry.id}: unresolvable cite ${cite}`,
        ).toBe(true);
      }
    }
  });

  it("requires a plan at ready-for-tom and a resolution at terminal status", () => {
    for (const entry of loadEntries()) {
      if (entry.readiness === "ready-for-tom") {
        expect(entry.plan?.trim().length, entry.id).toBeGreaterThan(0);
      }
      if (entry.status === "done" || entry.status === "archived") {
        expect(entry.resolution?.trim().length, entry.id).toBeGreaterThan(0);
      }
    }
  });
});
