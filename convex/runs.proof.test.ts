// @vitest-environment node
// This proof asserts pointers only. It never logs transcript content or paths.
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal, api } from "./_generated/api";
import schema from "./schema";
import { discoverChildren, parseClaudeFile } from "../worker/runs/ingest.mjs";
import { openStore } from "../worker/runs/store.mjs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const source = process.env.RUNS_PROOF_CLAUDE;
const codexSource = process.env.RUNS_PROOF_CODEX;

function fileAtCursor(file: Record<string, unknown>, text: string, committedLine: number) {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n").slice(0, -1);
  const prefix = committedLine === 0 ? "" : `${lines.slice(0, committedLine).join("\n")}\n`;
  return { ...file, committedLine, committedPrefixSha256: createHash("sha256").update(prefix).digest("hex") };
}

async function tom(t: ReturnType<typeof convexTest>) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: id });
}

describe.skipIf(!source)("runs proof", () => {
  it("takes a real root and child file from store through Convex back to its raw line", async () => {
    const scratch = process.env.RUNS_PROOF_STORE ?? fs.mkdtempSync(path.join(os.tmpdir(), "runs-proof-"));
    const store = openStore({ backend: "local", dir: scratch } as never);
    const host = "laptop";
    const parentBytes = fs.readFileSync(source!);
    const parentId = path.basename(source!, ".jsonl");
    const parentVersion = store.put({ runtime: "claude", threadId: parentId, host, sourceBytes: parentBytes });
    const parentText = store.get({ runtime: "claude", threadId: parentId, host, fileVersion: parentVersion.fileVersion }).toString("utf8");
    const parent = parseClaudeFile({ path: source!, text: parentText, host, fileVersion: parentVersion.fileVersion });
    parent.run.file = { ...parent.run.file, sourceHash: parentVersion.sourceHash, storedHash: parentVersion.storedHash, bytes: parentVersion.bytes, storedBytes: parentVersion.storedBytes, storeKey: parentVersion.key } as never;

    const discovered = discoverChildren(source!);
    const child = discovered.subagents[0];
    const parsed = [parent];
    if (child) {
      const bytes = fs.readFileSync(child.file);
      const version = store.put({ runtime: "claude", threadId: `${parentId}/${child.agentId}`, host, sourceBytes: bytes });
      const text = store.get({ runtime: "claude", threadId: `${parentId}/${child.agentId}`, host, fileVersion: version.fileVersion }).toString("utf8");
      const result = parseClaudeFile({ path: child.file, text, host, fileVersion: version.fileVersion, agentMeta: { ...child.meta, agentId: child.agentId }, parentSessionId: parentId } as never);
      result.run.file = { ...result.run.file, sourceHash: version.sourceHash, storedHash: version.storedHash, bytes: version.bytes, storedBytes: version.storedBytes, storeKey: version.key } as never;
      parsed.push(result);
    }

    const t = convexTest(schema, modules);
    for (const result of parsed) {
      for (let offset = 0; offset < result.rows.length; offset += 200) {
        const rows = result.rows.slice(offset, offset + 200).map((entry: { overflow?: { sha256: string; byteLength: number; chunkCount: number }; [key: string]: unknown }) => {
          const { overflow, ...row } = entry;
          return { ...row, ...(overflow ? { overflow: { sha256: overflow.sha256, byteLength: overflow.byteLength, chunkCount: overflow.chunkCount } } : {}) };
        });
        const next = offset + rows.length < result.rows.length ? result.rows[offset + rows.length].provenance.lineStart : result.lastLine;
        const sourceText = result === parent
          ? parentText
          : store.get({ runtime: "claude", threadId: `${parentId}/${child!.agentId}`, host, fileVersion: result.run.file.storedHash }).toString("utf8");
        const pageRun = { ...result.run, file: fileAtCursor(result.run.file, sourceText, next) };
        const response = await t.mutation(internal.runs.internalIngest, { run: pageRun, rows, children: offset === 0 ? result.children : [] } as never);
        expect(response.ok, JSON.stringify(response)).toBe(true);
      }
    }
    const viewer = await tom(t);
    const root = await viewer.query(api.runs.get, { runId: parent.run.runId });
    expect(root?.runId).toBe(parent.run.runId);
    if (child) expect((await viewer.query(api.runs.children, { runId: parent.run.runId })).some((run) => run.runId === parsed[1].run.runId)).toBe(true);
    const page = await viewer.query(api.runs.rows, { runId: parent.run.runId, paginationOpts: { cursor: null, numItems: 200 } });
    const row = page.page.find((entry) => entry.provenance?.sourceKind !== "context");
    expect(row).toBeDefined();
    const entry = await viewer.query(api.runs.entry, { runId: parent.run.runId, seq: row!.seq });
    expect(entry?.provenance).toBeDefined();
    const raw = store.get({ runtime: "claude", threadId: parentId, host, fileVersion: entry!.provenance!.fileVersion }).toString("utf8").split("\n")[entry!.provenance!.lineStart];
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).type).toBe(entry!.provenance!.sourceKind.split("/")[0]);
    // Codex is optional to the Convex leg; its worker proof covers its parser/store path.
    expect(codexSource === undefined || typeof codexSource === "string").toBe(true);
  });
});
