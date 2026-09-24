// The daemon's half of tom.quest/secrets (worker/session-host/secret-mailbox.mjs).
// The behavior half runs deliverSecrets against a real env file through the
// real writer; the wiring half reads session-host.mjs as TEXT (it imports the
// Agent SDK and the worker-env symlink and cannot be loaded here), as
// env-scrub.test.mjs does.
//
// What must hold: a waiting value lands in the env file and is reported
// taken; a failed write reports nothing, so the value stays waiting; no log
// line ever carries a value; the names in the mailbox block leave the
// daemon's environment before anything is spawned.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../../test/temp.mjs";

import { dropNames, deliverSecrets } from "../secret-mailbox.mjs";
import { loadEnv, mailboxNames, setEnvLine } from "../../jobs/worker-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostSource = fs.readFileSync(path.join(here, "..", "session-host.mjs"), "utf8");

const VALUE = "hf_live_value_1234567890";
function envFile(body = "CONVEX_SITE_URL=https://x.convex.site\n") {
  const dir = tempDir("secret-mailbox-");
  const file = path.join(dir, "worker.env");
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

function harness(file, rows, { markTaken } = {}) {
  const lines = [];
  const reports = [];
  return {
    lines,
    reports,
    io: {
      fetchPending: async () => ({ secrets: rows }),
      write: (name, value) => setEnvLine({ path: file, name, value }),
      markTaken:
        markTaken ??
        (async (name, setAt) => {
          reports.push({ name, setAt });
          return { ok: true };
        }),
      log: (...args) => lines.push(args.join(" ")),
    },
  };
}


describe("deliverSecrets", () => {
  it("writes a waiting value into the env file and reports it taken", async () => {
    const file = envFile();
    const h = harness(file, [{ name: "HF_TOKEN", value: VALUE, setAt: 111 }]);
    expect(await deliverSecrets(h.io)).toEqual(["HF_TOKEN"]);
    expect(loadEnv({ path: file }).HF_TOKEN).toBe(VALUE);
    expect(mailboxNames({ path: file })).toEqual(["HF_TOKEN"]);
    expect(h.reports).toEqual([{ name: "HF_TOKEN", setAt: 111 }]);
  });

  it("logs the variable's name and never its value", async () => {
    const file = envFile();
    const h = harness(file, [{ name: "HF_TOKEN", value: VALUE, setAt: 1 }]);
    await deliverSecrets(h.io);
    expect(h.lines).toEqual(["secrets: HF_TOKEN written to the env file"]);
  });

  it("keeps the value out of the log when the write fails, and reports nothing", async () => {
    const file = envFile();
    const h = harness(file, [{ name: "HF_TOKEN", value: VALUE, setAt: 1 }]);
    h.io.write = () => {
      throw new Error(`disk refused ${VALUE}`);
    };
    expect(await deliverSecrets(h.io)).toEqual([]);
    expect(h.reports).toEqual([]);
    expect(h.lines.join("\n")).toMatch(/HF_TOKEN not written/);
    expect(h.lines.join("\n")).not.toContain(VALUE);
  });

  it("keeps the value out of the log when the taken report fails", async () => {
    const file = envFile();
    const h = harness(file, [{ name: "HF_TOKEN", value: VALUE, setAt: 1 }], {
      markTaken: async () => {
        const err = new Error(`/sessions/secrets/taken -> HTTP 409: ${VALUE}`);
        err.status = 409;
        throw err;
      },
    });
    expect(await deliverSecrets(h.io)).toEqual(["HF_TOKEN"]);
    expect(h.lines.join("\n")).toMatch(/HF_TOKEN written; the taken report failed \(409\)/);
    expect(h.lines.join("\n")).not.toContain(VALUE);
  });

  it("delivering the same name twice leaves one line with the newer value", async () => {
    const file = envFile();
    await deliverSecrets(harness(file, [{ name: "HF_TOKEN", value: "old-value", setAt: 1 }]).io);
    await deliverSecrets(harness(file, [{ name: "HF_TOKEN", value: "new-value", setAt: 2 }]).io);
    const text = fs.readFileSync(file, "utf8");
    expect(text.match(/^HF_TOKEN=/gm)).toHaveLength(1);
    expect(loadEnv({ path: file }).HF_TOKEN).toBe("new-value");
  });

  it("skips a malformed row and survives an unreadable mailbox", async () => {
    const file = envFile();
    const h = harness(file, [{ name: "bad name", value: VALUE, setAt: 1 }]);
    expect(await deliverSecrets(h.io)).toEqual([]);
    expect(h.lines.join("\n")).not.toContain(VALUE);
    h.io.fetchPending = async () => {
      const err = new Error("HTTP 503");
      err.status = 503;
      throw err;
    };
    expect(await deliverSecrets(h.io)).toEqual([]);
    expect(h.lines.at(-1)).toBe("secrets: could not read the mailbox: 503");
  });
});

describe("dropNames", () => {
  it("removes the mailbox names and nothing else", () => {
    const target = { HF_TOKEN: VALUE, PATH: "/usr/bin", TTS_WORKER_KEY: "k" };
    dropNames(target, ["HF_TOKEN"]);
    expect(target).toEqual({ PATH: "/usr/bin", TTS_WORKER_KEY: "k" });
  });
});

describe("wiring in session-host.mjs", () => {
  it("drops the mailbox names from process.env before the first spawn", () => {
    const drop = hostSource.indexOf("dropNames(process.env, delivered)");
    expect(drop).toBeGreaterThan(-1);
    expect(hostSource).toMatch(/const delivered = mailboxNames\(\);/);
    expect(drop).toBeLessThan(hostSource.indexOf("codexReady = warmUpCodex()"));
    expect(drop).toBeLessThan(hostSource.indexOf("for (;;) {"));
  });

  it("checks the mailbox from the poll loop through the daemon's own doors", () => {
    expect(hostSource).toMatch(/checkSecrets\(env\);/);
    expect(hostSource).toMatch(/sessionsGet\(env, "\/sessions\/secrets"\)/);
    expect(hostSource).toMatch(/sessionsFetch\(env, "\/sessions\/secrets\/taken", \{ name, setAt \}\)/);
    // A delivered value is written to the file and never put in process.env.
    expect(hostSource).not.toMatch(/process\.env\[name\]\s*=/);
  });
});
