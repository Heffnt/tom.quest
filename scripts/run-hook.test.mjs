import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { registrationSidecarPath, writeRegistration, writeRegistrationReceipt } from "../worker/runs/registration.mjs";

const SCRIPT = path.resolve("scripts/run-hook.mjs");

// The hook resolves its registration module off import.meta.url, and neither a
// static nor a dynamic import of it survives the vitest transform, which hands
// the module a non-file URL. This suite already drives the hook as a Node
// subprocess; ask the same Node for the exported rule rather than keeping a
// second copy of it here.
function currentRunPointerPath(stateDir, cwd) {
  const probe = "const m = await import(process.argv[1]); process.stdout.write(m.currentRunPointerPath(process.argv[2], process.argv[3]));";
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe, pathToFileURL(SCRIPT).href, stateDir, cwd], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

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
      TTS_RUN_REG_TOKEN: "",
      TTS_RUN_REG_SPOOL: "",
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
              registration: { cli: runner, hooksConfigured: ["SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"] },
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
      registration: { host: "laptop", cli: "claude", origin: "cron:evals", kind: "job" },
    });
    writeRegistrationReceipt({
      runFile: payload.transcript_path,
      receipt: { skillsGranted: ["write"], skillsRefused: ["know-private"] },
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
      receipt: { skillsGranted: ["write"], skillsRefused: ["know-private"] },
    });
  });

  it("records laptop startup layers but leaves skills unknown without the session-start receipt", () => {
    const f = fixture();
    const payload = payloadFor(f.root, "claude", "SessionStart");
    const result = run(payload, { ...f, env: { RUN_HOST: "" } });
    expect(result.status).toBe(0);
    const envelope = JSON.parse(fs.readFileSync(registrationSidecarPath(payload.transcript_path), "utf8"));
    // The session-start hook owns the actual skill decision: publication can
    // refuse a body without refusing the session. This hook therefore has no
    // static skillsGranted claim when it did not receive that receipt.
    expect(envelope.registration).toMatchObject({
      host: null,
      origin: "laptop",
      environment: "session",
      layersKnown: true,
      layersGiven: ["operate"],
      layersDenied: [],
    });
    expect(envelope.registration.skillsGranted).toBeUndefined();
    expect(envelope.registration.skillsRefused).toBeUndefined();
  });

  it("preserves the session-start hook's actual grant receipt without masking it as registration", () => {
    const f = fixture();
    const payload = payloadFor(f.root, "claude", "SessionStart");
    writeRegistrationReceipt({
      runFile: payload.transcript_path,
      receipt: { skillsGranted: [], skillsRefused: ["write"] },
    });
    expect(run(payload, { ...f, env: { RUN_HOST: "laptop" } }).status).toBe(0);
    const envelope = JSON.parse(fs.readFileSync(registrationSidecarPath(payload.transcript_path), "utf8"));
    expect(envelope.registration).toMatchObject({
      layersGiven: ["operate"],
    });
    expect(envelope.registration.skillsGranted).toBeUndefined();
    expect(envelope.registration.skillsRefused).toBeUndefined();
    expect(envelope.receipt).toMatchObject({ skillsGranted: [], skillsRefused: ["write"] });
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
    // Silent, so the record gives it its parent's environment.
    expect(envelope.registration).not.toHaveProperty("environment");
  });

  it("names no environment for a box session, whose launcher owns that word", () => {
    const f = fixture();
    const payload = payloadFor(f.root, "claude", "SessionStart");
    expect(run(payload, { ...f, env: { RUN_HOST: "box" } }).status).toBe(0);
    const envelope = JSON.parse(fs.readFileSync(registrationSidecarPath(payload.transcript_path), "utf8"));
    expect(envelope.registration).toMatchObject({ host: "box", kind: "session" });
    expect(envelope.registration).not.toHaveProperty("environment");
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

  it("hands the box transport the laptop session's run id, then takes it back", () => {
    const f = fixture();
    const start = payloadFor(f.root, "claude", "SessionStart");
    expect(run(start, { ...f, env: { RUN_HOST: "laptop" } }).status).toBe(0);
    const pointer = currentRunPointerPath(f.state, start.cwd);
    expect(JSON.parse(fs.readFileSync(pointer, "utf8"))).toMatchObject({
      runId: "claude:laptop:parent",
      rootRunId: "claude:laptop:parent",
      depth: 0,
      sessionId: "parent",
      runFile: path.resolve(start.transcript_path),
    });

    expect(run({ ...start, hook_event_name: "SessionEnd", reason: "completed" }, { ...f, env: { RUN_HOST: "laptop" } }).status).toBe(0);
    expect(fs.existsSync(pointer)).toBe(false);
  });

  it("writes no pointer without a cwd, and never fails a session over one", () => {
    const f = fixture();
    const cwdless = payloadFor(f.root, "claude", "SessionStart");
    delete cwdless.cwd;
    expect(run(cwdless, f).status).toBe(0);
    expect(fs.existsSync(path.join(f.state, "current"))).toBe(false);

    // An unwritable state directory is a hook problem, never a session's.
    const blocked = path.join(f.root, "blocking-file");
    fs.writeFileSync(blocked, "not a directory");
    const result = run(payloadFor(f.root, "claude", "SessionStart"), { ...f, state: path.join(blocked, "state") });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

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
