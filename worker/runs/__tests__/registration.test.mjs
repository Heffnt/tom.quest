import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  claimRegistration,
  findCodexRegistration,
  mergeRegistration,
  readRegistration,
  registrationSidecarPath,
  writeRegistration,
  writeRegistrationEnd,
} from "../registration.mjs";
import { codexResponseItem, jsonl } from "./fixtures.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runs-registration-"));
const parsed = () => ({
  run: {
    runId: "codex:laptop:child", parentRunId: "codex:laptop:file-parent", rootRunId: "codex:laptop:file-parent", depth: 1,
    linkKnown: false, origin: "unknown", kind: "codex-child", host: "laptop", model: "file-model", status: "unknown",
    context: { layersKnown: true, layersGiven: ["inferred"], layersDenied: [], skillsOffered: [], skillsUsed: [], tools: ["seen"], hooks: [], wikitomCommit: "file-commit" },
    outcome: { totals: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 }, turns: 1, toolCalls: 0 },
  },
  rows: [], children: [],
});

describe("run registration", () => {
  it("derives the same sidecar rule for roots, subagents, and rollouts", () => {
    for (const file of ["/p/session.jsonl", "/p/session/subagents/agent-a.jsonl", "/c/rollout-time-id.jsonl"]) {
      expect(registrationSidecarPath(file)).toBe(path.resolve(file).replace(/\.jsonl$/, ".registration.json"));
    }
  });

  it("claims a spool while preserving an end written first", () => {
    const dir = temp(); const spoolDir = path.join(dir, "spool"); const runFile = path.join(dir, "run.jsonl");
    const token = "11111111-1111-4111-8111-111111111111";
    writeRegistration({ spoolDir, token, writer: { file: "launcher.mjs" }, registration: { host: "laptop", origin: "job" }, now: () => 1 });
    writeRegistrationEnd({ runFile, end: { reason: "done" }, now: () => 2 });
    const result = claimRegistration({ spoolDir, token, runFile, claim: { by: "hook:SessionStart", threadId: "thread" }, now: () => 3 });
    expect(result.ok).toBe(true);
    expect(result.envelope).toMatchObject({ writer: { file: "launcher.mjs" }, registration: { origin: "job" }, claim: { by: "hook:SessionStart" }, end: { reason: "done", status: "ended" } });
    expect(fs.existsSync(path.join(spoolDir, `${token}.json`))).toBe(false);
  });

  it("keeps a same-token sidecar intact instead of bootstrapping its spool again", () => {
    const dir = temp(); const spoolDir = path.join(dir, "spool"); const runFile = path.join(dir, "run.jsonl");
    const token = "44444444-4444-4444-8444-444444444444";
    writeRegistration({ spoolDir, token, writer: { file: "stale-launcher.mjs" }, registration: { host: "laptop", origin: "stale" }, now: () => 1 });
    const sidecar = path.join(dir, "run.registration.json");
    fs.writeFileSync(sidecar, JSON.stringify({
      envelopeVersion: 1,
      token,
      writer: { file: "sidecar-launcher.mjs", at: 2 },
      registration: { host: "laptop", origin: "sidecar" },
      claim: { by: "hook:SessionStart", at: 2 },
    }));

    const result = claimRegistration({ spoolDir, token, runFile, claim: { by: "repair" }, now: () => 3 });
    expect(result).toMatchObject({ ok: true, claimed: false, envelope: { writer: { file: "sidecar-launcher.mjs" }, registration: { origin: "sidecar" }, claim: { by: "hook:SessionStart" } } });
    expect(fs.existsSync(path.join(spoolDir, `${token}.json`))).toBe(true);
  });

  it("replaces a corrupt spool with the launcher-owned envelope", () => {
    const dir = temp(); const spoolDir = path.join(dir, "spool");
    const token = "33333333-3333-4333-8333-333333333333";
    fs.mkdirSync(spoolDir, { recursive: true });
    fs.writeFileSync(path.join(spoolDir, `${token}.json`), "not json");
    const result = writeRegistration({ spoolDir, token, writer: { file: "launcher.mjs" }, registration: { host: "laptop" }, now: () => 1 });
    expect(JSON.parse(fs.readFileSync(result.file, "utf8"))).toEqual(result.envelope);
  });

  it("keeps file facts while registration owns its exact fields", () => {
    const result = mergeRegistration({ parsed: parsed(), host: "laptop", envelope: { writer: { file: "scripts/codex-run.mjs" }, registration: { host: "laptop", origin: "cron:audit", kind: "job", modelRequested: "requested", parentRunId: "codex:laptop:registered-parent", layersKnown: true, layersGiven: ["operate"], layersDenied: ["write"], wikitomCommit: "envelope-commit", promptSha256: "hash" }, end: { status: "failed", reason: "failed" } } });
    expect(result.run).toMatchObject({ model: "file-model", origin: "cron:audit", kind: "job", parentRunId: "codex:laptop:registered-parent", status: "failed" });
    expect(result.run.context).toMatchObject({ registered: true, modelRequested: "requested", layersGiven: ["operate"], wikitomCommit: "file-commit", tools: ["seen"] });
  });

  it("refuses a host mismatch and makes missing registration honestly unknown", () => {
    const report = vi.fn();
    const mismatch = mergeRegistration({ parsed: parsed(), host: "laptop", envelope: { registration: { host: "box", layersKnown: true, layersGiven: ["operate"] } }, report });
    expect(mismatch.envelopeApplied).toBe(false);
    expect(mismatch.run.context).toMatchObject({ registered: false, layersKnown: false, layersGiven: [] });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ kind: "runs-envelope-host-mismatch" }));
    const absent = mergeRegistration({ parsed: parsed(), host: "laptop", envelope: null });
    expect(absent.run.context).toMatchObject({ registered: false, layersKnown: false, layersGiven: [], layersDenied: [] });
  });

  it("carries the envelope's token onto the run, and never one a mismatch refused", () => {
    const envelope = { token: "11111111-2222-4333-8444-555555555555", writer: { file: "worker/jobs/prepare.mjs" }, registration: { host: "laptop", layersKnown: false } };
    const applied = mergeRegistration({ parsed: parsed(), host: "laptop", envelope });
    // The one exact edge from a row an agent wrote for Tom back to the run
    // that wrote it. convex/runLabels.ts resolves it on runs.by_reg_token.
    expect(applied.run.regToken).toBe("11111111-2222-4333-8444-555555555555");

    // A refused envelope describes a DIFFERENT MACHINE'S RUN, and stamping its
    // token here would make exactly the wrong edge — which is worse than none,
    // because a wrong edge poisons the eval corpus silently.
    const mismatched = mergeRegistration({ parsed: parsed(), host: "laptop", envelope: { ...envelope, registration: { host: "box", layersKnown: false } }, report: () => {} });
    expect(mismatched.run.regToken).toBeUndefined();

    // An unregistered run carries no token at all, and absent is a value.
    expect(mergeRegistration({ parsed: parsed(), host: "laptop", envelope: null }).run.regToken).toBeUndefined();
  });

  it("only upgrades a Codex child's link with a real tool-use id", () => {
    const without = mergeRegistration({ parsed: parsed(), host: "laptop", envelope: { writer: { file: "scripts/codex-run.mjs" }, registration: { host: "laptop", parentRunId: "codex:laptop:parent", layersKnown: false } } });
    expect(without.run.linkKnown).toBe(false);
    const untrusted = mergeRegistration({ parsed: parsed(), host: "laptop", envelope: { writer: { file: "launcher.mjs" }, registration: { host: "laptop", spawnedByToolUseId: "made-up", layersKnown: false } } });
    expect(untrusted.run).toMatchObject({ linkKnown: false });
    expect(untrusted.run.spawnedByToolUseId).toBeUndefined();
    const withoutPayloadKey = mergeRegistration({ parsed: parsed(), host: "laptop", envelope: { writer: { file: "scripts/run-hook.mjs" }, claim: { by: "hook:SubagentStart", hookPayloadKeys: ["agent_id"] }, registration: { host: "laptop", spawnedByToolUseId: "made-up", layersKnown: false } } });
    expect(withoutPayloadKey.run.linkKnown).toBe(false);
    const withId = mergeRegistration({ parsed: parsed(), host: "laptop", envelope: { writer: { file: "scripts/run-hook.mjs" }, claim: { by: "hook:SubagentStart", hookPayloadKeys: ["agent_id", "tool_use_id"] }, registration: { host: "laptop", spawnedByToolUseId: "tool-1", layersKnown: false } } });
    expect(withId.run).toMatchObject({ linkKnown: true, spawnedByToolUseId: "tool-1" });
  });

  it("claims a Codex spool only from the first persisted developer instruction", () => {
    const dir = temp(); const spoolDir = path.join(dir, "spool"); const runFile = path.join(dir, "rollout.jsonl");
    const token = "22222222-2222-4222-8222-222222222222";
    writeRegistration({ spoolDir, token, writer: { file: "scripts/codex-run.mjs" }, registration: { host: "laptop" }, now: () => 1 });
    const result = findCodexRegistration({
      text: jsonl([
        codexResponseItem("message", { role: "developer", content: [{ input_text: `instructions\nTTS-RUN-TOKEN: ${token}` }] }),
        codexResponseItem("message", { role: "assistant", content: [{ output_text: `echo\nTTS-RUN-TOKEN: 55555555-5555-4555-8555-555555555555` }] }),
      ]),
      spoolDir, runFile, claim: { threadId: "thread" }, now: () => 2,
    });
    expect(result.ok).toBe(true);
    expect(readRegistration(runFile)).toMatchObject({ token, claim: { by: "sweep:codex-token", threadId: "thread" } });
  });

  it("refuses tokens echoed after the first developer instruction", () => {
    const dir = temp(); const spoolDir = path.join(dir, "spool"); const runFile = path.join(dir, "rollout.jsonl");
    const token = "66666666-6666-4666-8666-666666666666";
    writeRegistration({ spoolDir, token, writer: { file: "scripts/codex-run.mjs" }, registration: { host: "laptop" }, now: () => 1 });
    const result = findCodexRegistration({
      text: jsonl([
        codexResponseItem("message", { role: "developer", content: [{ input_text: "first developer instruction" }] }),
        codexResponseItem("message", { role: "assistant", content: [{ output_text: `echo\nTTS-RUN-TOKEN: ${token}` }] }),
        codexResponseItem("message", { role: "developer", content: [{ input_text: `later developer echo\nTTS-RUN-TOKEN: ${token}` }] }),
      ]),
      spoolDir, runFile, claim: { threadId: "thread" }, now: () => 2,
    });
    expect(result).toMatchObject({ ok: false, reason: "run registration token absent" });
    expect(fs.existsSync(path.join(spoolDir, `${token}.json`))).toBe(true);
    expect(fs.existsSync(registrationSidecarPath(runFile))).toBe(false);
  });
});
