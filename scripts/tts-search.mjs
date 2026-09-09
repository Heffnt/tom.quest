#!/usr/bin/env node
// Laptop entrypoint; the implementation is shared with the Jarvis Box.
import { LAPTOP_WIKITOM_DIR, runSearchCli } from "../worker/jobs/search-lib.mjs";

const code = await runSearchCli(process.argv.slice(2), { defaultWikiTom: LAPTOP_WIKITOM_DIR });
if (code !== 0) process.exitCode = code;
