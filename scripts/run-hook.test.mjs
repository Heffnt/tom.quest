import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { registrationSidecarPath, writeRegistration } from "../worker/runs/registration.mjs";

const SCRIPT = path.resolve("scripts/run-hook.mjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-hook-"));
  const state = path.join(root, "state");
  const sweep = path.join(root, "sweep.mjs");
  fs.writeFileSync(sweep, "process.exit(0);\n");
  return { root, state, sweep };
}

function run(payload, { state, sweep, env = {}, args = [] }) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      RUN_SWEEP_STATE_DIR: state,
      RUN_SWEEP_SCRIPT: sweep,
      ...env,
    },
  });
}

function payloadFor(root, runner, event) {
  const parent = runner === "claude"
    ? path.join(root, ".claude", "projects", "-project", "parent.jsonl")
    : path.join(root, ".codex", "sessions", "2026", "09", "11", "rollout-parent.jsonl");
  const child = runner === "claude"
    ? path.join(root, ".claude", "projects", "-project", "parent", "subagents", "agent-child.jsonl")
    : path.join(root, ".codex", "sessions", "2026", "09", "11", "rollout-child.jsonl");
  return {
    hook_event_name: event,
    runner,
    session_id: "parent",
    transcript_path: parent,
    agent_id: "child",
    agent_type: "general-purpose",
    agent_transcript_path: child,
    reason: event === "SessionEnd" ? "completed" : "done",
    cwd: root,
  };
}

describe("run lifecycle hook", () => {
  for (const runner of ["claude", "codex"]) {
    for (const event of ["SessionStart", "SubagentStart", "Stop", "SessionEnd", "SubagentStop"]) {
      it(`${runner} ${event} exits cleanly, stays silent, and writes only the event-owned groups`, () => {
        const f = fixture();
        const payload = payloadFor(f.root, runner, event);
        const result = run(payload, f);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        const runFile = event.startsWith("Subagent") ? payload.agent_transcript_path : payload.transcript_path;
        const sidecar = registrationSidecarPath(runFile);
        if (event === "Stop") {
          expect(fs.existsSync(sidecar)).toBe(false);
        } else {
          const envelope = JSON.parse(fs.readFileSync(sidecar, "utf8"));
          if (event === "SessionStart" || event === "SubagentStart") {
            expect(envelope).toMatchObject({
              token: null,
              writer: { file: "scripts/run-hook.mjs", job: "run-hook" },
              registration: { runner, hooksConfigured: ["SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"] },
              claim: { by: `hook:${event}`, runFile: path.resolve(runFile) },
            });
          } else {
            expect(envelope).toMatchObject({ end: { by: `hook:${event}`, status: "ended" } });
          }
        }
      });
    }
  }

  it("claims a launcher spool on SessionStart and removes the spool file", () => {
    const f = fixture();
    const payload = payloadFor(f.root, "claude", "SessionStart");
    const spoolDir = path.join(f.state, "registration");
    const spooled = writeRegistration({
      spoolDir,
      writer: { file: "worker/jobs/evals.mjs", job: "evals" },
      registration: { host: "laptop", runner: "claude", origin: "cron:evals", kind: "job" },
    });
    const result = run(payload, {
      ...f,
      env: { TTS_RUN_REG_TOKEN: spooled.token, TTS_RUN_REG_SPOOL: spoolDir },
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(spooled.file)).toBe(false);
    expect(JSON.parse(fs.readFileSync(registrationSidecarPath(payload.transcript_path), "utf8"))).toMatchObject({
      token: spooled.token,
      writer: { file: "worker/jobs/evals.mjs" },
      claim: { by: "hook:SessionStart" },
    });
  });

  it("knows laptop startup layers before RUN_HOST is configured", () => {
    const f = fixture();
    const payload = payloadFor(f.root, "claude", "SessionStart");
    const result = run(payload, { ...f, env: { RUN_HOST: "" } });
    expect(result.status).toBe(0);
    const envelope = JSON.parse(fs.readFileSync(registrationSidecarPath(payload.transcript_path), "utf8"));
    // The stable prefix session-start-hook.mjs loads is operate and write. The
    // know layer is expanded per subject, so it is in neither list.
    expect(envelope.registration).toMatchObject({
      host: null,
      origin: "laptop",
      layersKnown: true,
      layersGiven: ["operate", "write"],
      layersDenied: [],
    });
  });

  it("leaves a subagent's layers unknown rather than inheriting its parent's", () => {
    const f = fixture();
    const payload = payloadFor(f.root, "claude", "SubagentStart");
    expect(run(payload, { ...f, env: { RUN_HOST: "laptop" } }).status).toBe(0);
    const envelope = JSON.parse(fs.readFileSync(registrationSidecarPath(payload.agent_transcript_path), "utf8"));
    expect(envelope.registration).toMatchObject({
      kind: "subagent",
      layersKnown: false,
      layersGiven: [],
      layersDenied: [],
    });
  });

  it("SessionEnd preserves registration and claim while adding end", () => {
    const f = fixture();
    const start = payloadFor(f.root, "claude", "SessionStart");
    expect(run(start, f).status).toBe(0);
    const file = registrationSidecarPath(start.transcript_path);
    const before = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(run({ ...start, hook_event_name: "SessionEnd", reason: "API failure" }, f).status).toBe(0);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.registration).toEqual(before.registration);
    expect(after.claim).toEqual(before.claim);
    expect(after.end).toMatchObject({ reason: "API failure", status: "failed" });
  });

  for (const [name, input] of [
    ["non-JSON", "not json"],
    ["empty", ""],
    ["unknown", { hook_event_name: "SomeFutureEvent" }],
    ["pathless", { hook_event_name: "SessionStart" }],
    ["pathless ending", { hook_event_name: "SessionEnd", reason: "done" }],
  ]) {
    it(`${name} input exits 0, stays silent, and records only a hook log line`, () => {
      const f = fixture();
      const result = run(input, f);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(fs.readFileSync(path.join(f.state, "hook.log"), "utf8").trim().split("\n")).toHaveLength(1);
      expect(fs.readdirSync(f.state).sort()).toEqual(["hook.log"]);
    });
  }

  it("returns while its detached sweep child is still running", async () => {
    const f = fixture();
    const started = path.join(f.root, "started");
    const finished = path.join(f.root, "finished");
    fs.writeFileSync(
      f.sweep,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(started)}, "yes"); setTimeout(() => fs.writeFileSync(${JSON.stringify(finished)}, "yes"), 1500);\n`,
    );
    const before = Date.now();
    const result = run(payloadFor(f.root, "claude", "Stop"), f);
    const elapsed = Date.now() - before;
    expect(result.status).toBe(0);
    expect(elapsed).toBeLessThan(1000);
    for (let attempt = 0; attempt < 20 && !fs.existsSync(started); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.existsSync(started)).toBe(true);
    expect(fs.existsSync(finished)).toBe(false);
  });
});
