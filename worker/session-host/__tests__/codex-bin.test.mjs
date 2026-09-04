// @vitest-environment node
//
// codex-bin.mjs — the one home for the Codex binary, its spawn shim and the
// per-turn flags. CODEX_BIN is read at module load, so each resolution case
// re-imports the module after resetting vitest's module cache.
//
// This directory is deliberately NOT flat: setup.sh installs the daemon with
// `cp worker/session-host/*.mjs`, so this file never ships.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "fixtures", "fake-codex.mjs");
const savedBin = process.env.CODEX_BIN;
const savedPath = process.env.PATH;

async function load({ bin, PATH }) {
  vi.resetModules();
  if (bin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = bin;
  if (PATH !== undefined) process.env.PATH = PATH;
  return import("../codex-bin.mjs");
}

afterEach(() => {
  if (savedBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = savedBin;
  process.env.PATH = savedPath;
});

describe("resolveCodexBin", () => {
  it("resolves a CODEX_BIN path that exists", async () => {
    const { CODEX_BIN, resolveCodexBin } = await load({ bin: FAKE });
    expect(CODEX_BIN).toBe(FAKE);
    expect(resolveCodexBin()).toBe(FAKE);
  });

  it("is null for a CODEX_BIN path that does not exist", async () => {
    const { resolveCodexBin } = await load({ bin: path.join(here, "no-such-codex") });
    expect(resolveCodexBin()).toBeNull();
  });

  it("searches PATH for a bare name and is null when absent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bin-test-"));
    try {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bin-empty-"));
      const { resolveCodexBin: missing } = await load({ bin: undefined, PATH: empty });
      expect(missing()).toBeNull();
      fs.writeFileSync(path.join(dir, "codex"), "#!/bin/sh\n");
      const { CODEX_BIN, resolveCodexBin } = await load({ bin: undefined, PATH: `${empty}${path.delimiter}${dir}` });
      expect(CODEX_BIN).toBe("codex");
      expect(resolveCodexBin()).toBe(path.join(dir, "codex"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnCodex", () => {
  it("runs a script CODEX_BIN under this node with the args appended", async () => {
    const { spawnCodex, codexArgs } = await load({ bin: FAKE });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bin-spawn-"));
    const argsFile = path.join(tmp, "args.jsonl");
    try {
      const child = spawnCodex(codexArgs({ cwd: tmp, model: "gpt-5.6-terra", effort: "low" }), {
        cwd: tmp,
        env: { ...process.env, FAKE_CODEX_ARGS_FILE: argsFile },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end("reply ok");
      const code = await new Promise((resolve) => child.on("close", resolve));
      expect(code).toBe(0);
      const [run] = fs.readFileSync(argsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(run.prompt).toBe("reply ok");
      expect(run.argv.slice(0, 2)).toEqual(["exec", "--json"]);
      expect(run.argv).toContain("gpt-5.6-terra");
      expect(run.argv).toContain('model_reasoning_effort="low"');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("codexArgs has one home", () => {
  it("codex-query.mjs re-exports the same function", async () => {
    const bin = await load({ bin: FAKE });
    const query = await import("../codex-query.mjs");
    expect(query.codexArgs).toBe(bin.codexArgs);
  });
});
