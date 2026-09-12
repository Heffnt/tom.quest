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
import { discoverChildren, parseClaudeFile, parseCodexFile } from "../worker/runs/ingest.mjs";
import { openStore } from "../worker/runs/store.mjs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const source = process.env.RUNS_PROOF_CLAUDE;
const codexSource = process.env.RUNS_PROOF_CODEX;

function fileAtCursor(file: Record<string, unknown>, sourceText: string, committedLine: number) {
  const lines = sourceText.endsWith("\n") ? sourceText.slice(0, -1).split("\n") : sourceText.split("\n").slice(0, -1);
  const prefix = committedLine === 0 ? "" : `${lines.slice(0, committedLine).join("\n")}\n`;
  return { ...file, committedLine, committedPrefixSha256: createHash("sha256").update(prefix).digest("hex") };
}

async function tom(t: ReturnType<typeof convexTest>) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: id });
}

describe.skipIf(!source || !codexSource)("runs proof", () => {
  it("takes mandatory Claude root/child and Codex fixtures through immutable storage and Convex", async () => {
    const scratch = process.env.RUNS_PROOF_STORE ?? fs.mkdtempSync(path.join(os.tmpdir(), "runs-proof-"));
    const store = openStore({ backend: "local", dir: scratch } as never);
    const host = "laptop";
    const parentBytes = fs.readFileSync(source!);
    const parentId = path.basename(source!, ".jsonl");
    const discovered = discoverChildren(source!);
    expect(discovered.subagents.length, "the proof fixture must contain a Claude child").toBeGreaterThan(0);
    const child = discovered.subagents[0]!;
    const childBytes = fs.readFileSync(child.file);
    const codexBytes = fs.readFileSync(codexSource!);

    const parentVersion = store.put({ runtime: "claude", threadId: parentId, host, sourceBytes: parentBytes });
    const childVersion = store.put({ runtime: "claude", threadId: `${parentId}/${child.agentId}`, host, sourceBytes: childBytes });
    let codexId = path.basename(codexSource!, path.extname(codexSource!));
    for (const raw of codexBytes.toString("utf8").split("\n")) {
      try {
        const entry = JSON.parse(raw);
        if (entry.type === "session_meta") {
          codexId = entry.payload?.id ?? entry.payload?.session_id ?? codexId;
          break;
        }
      } catch { /* a malformed fixture line is the parser's fact to record */ }
    }
    const codexVersion = store.put({ runtime: "codex", threadId: codexId, host, sourceBytes: codexBytes });
    for (const [runtime, threadId, version] of [
      ["claude", parentId, parentVersion],
      ["claude", `${parentId}/${child.agentId}`, childVersion],
      ["codex", codexId, codexVersion],
    ] as const) {
      expect(store.head({ runtime, threadId, host, fileVersion: version.fileVersion, sourceHash: version.sourceHash })?.storedHash).toBe(version.storedHash);
    }

    const parentStored = store.get({ runtime: "claude", threadId: parentId, host, fileVersion: parentVersion.fileVersion }).toString("utf8");
    const childStored = store.get({ runtime: "claude", threadId: `${parentId}/${child.agentId}`, host, fileVersion: childVersion.fileVersion }).toString("utf8");
    const codexStored = store.get({ runtime: "codex", threadId: codexId, host, fileVersion: codexVersion.fileVersion }).toString("utf8");
    const parent = parseClaudeFile({ path: source!, text: parentStored, host, fileVersion: parentVersion.fileVersion, attachments: discovered.toolResults });
    const parsedChild = parseClaudeFile({ path: child.file, text: childStored, host, fileVersion: childVersion.fileVersion, agentMeta: { ...child.meta, agentId: child.agentId }, parentSessionId: parentId, attachments: [] } as never);
    const codex = parseCodexFile({ path: codexSource!, text: codexStored, host, fileVersion: codexVersion.fileVersion });
    const parsed = [
      { result: parent, version: parentVersion, sourceText: parentBytes.toString("utf8") },
      { result: parsedChild, version: childVersion, sourceText: childBytes.toString("utf8") },
      { result: codex, version: codexVersion, sourceText: codexBytes.toString("utf8") },
    ];

    for (const { result, version, sourceText } of parsed) {
      result.run.file = { ...result.run.file, sourceHash: version.sourceHash, storedHash: version.storedHash, bytes: version.bytes, storedBytes: version.storedBytes, storeKey: version.key } as never;
      expect(result.run.attachments).toEqual(expect.any(Array));
      expect(result.run.outcome?.totals).toMatchObject({
        cacheWrite5mTokens: expect.any(Number),
        cacheWrite1hTokens: expect.any(Number),
        cacheWriteBreakdownKnown: expect.any(Boolean),
      });
      const sourcePrefix = fileAtCursor(result.run.file, sourceText, result.lastLine);
      expect(sourcePrefix.committedPrefixSha256).not.toBe("");
    }

    const t = convexTest(schema, modules);
    for (const { result, sourceText } of parsed) {
      let previousCommittedLine = 0;
      let previousPrefixSha256 = createHash("sha256").update("").digest("hex");
      for (let offset = 0; offset < result.rows.length; offset += 200) {
        const rows = result.rows.slice(offset, offset + 200).map((entry: { overflow?: unknown; [key: string]: unknown }) => {
          const { overflow: _overflow, ...row } = entry;
          return row;
        });
        const next = offset + rows.length < result.rows.length ? result.rows[offset + rows.length].provenance.lineStart : result.lastLine;
        const pageRun = { ...result.run, file: fileAtCursor(result.run.file, sourceText, next) };
        const response = await t.mutation(internal.runs.internalIngest, {
          run: pageRun,
          rows,
          children: offset === 0 ? result.children : [],
          previousCommittedLine,
          previousPrefixSha256,
        } as never);
        expect(response.ok, JSON.stringify(response)).toBe(true);
        previousCommittedLine = next;
        previousPrefixSha256 = pageRun.file.committedPrefixSha256 as string;
      }
    }

    const viewer = await tom(t);
    const root = await viewer.query(api.runs.get, { runId: parent.run.runId });
    expect(root?.runId).toBe(parent.run.runId);
    const children = await viewer.query(api.runs.children, { runId: parent.run.runId });
    expect(children.items.some((entry) => entry.runId === parsedChild.run.runId)).toBe(true);
    const childRun = await viewer.query(api.runs.get, { runId: parsedChild.run.runId });
    expect(childRun).toMatchObject({ parentRunId: parent.run.runId, rootRunId: parent.run.runId, depth: 1 });
    expect((await viewer.query(api.runs.get, { runId: codex.run.runId }))?.runner).toBe("codex");

    const page = await viewer.query(api.runs.rows, { runId: parent.run.runId, paginationOpts: { cursor: null, numItems: 200 } });
    const entry = page.page.find((candidate) => candidate.provenance?.sourceKind !== "context");
    expect(entry).toBeDefined();
    const pointer = await viewer.query(api.runs.entry, { runId: parent.run.runId, seq: entry!.seq });
    expect(pointer?.provenance?.fileVersion).toBe(parentVersion.storedHash);
    const raw = parentStored.split("\n")[pointer!.provenance!.lineStart];
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
