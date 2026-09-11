#!/usr/bin/env node
// Laptop entrypoint; the implementation is shared with the Jarvis Box.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAPTOP_WIKITOM_DIR, runSearchCli } from "../worker/jobs/search-lib.mjs";
import { loadEnv } from "../worker/jobs/worker-env.mjs";

if (!process.env.CONVEX_SITE_URL || !process.env.TTS_WORKER_KEY) {
  const envFile = path.join(path.resolve(process.env.HOME || process.env.USERPROFILE || os.homedir()), ".tts", "env");
  if (fs.existsSync(envFile)) {
    const fromFile = loadEnv({ path: envFile });
    if (!process.env.CONVEX_SITE_URL && fromFile.CONVEX_SITE_URL) process.env.CONVEX_SITE_URL = fromFile.CONVEX_SITE_URL;
    if (!process.env.TTS_WORKER_KEY && fromFile.TTS_WORKER_KEY) process.env.TTS_WORKER_KEY = fromFile.TTS_WORKER_KEY;
  }
}

const code = await runSearchCli(process.argv.slice(2), { defaultWikiTom: LAPTOP_WIKITOM_DIR });
if (code !== 0) process.exitCode = code;
