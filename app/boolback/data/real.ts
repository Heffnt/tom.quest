// app/boolback/data/real.ts — thin snapshot validator.
//
// The CMT tom_quest builder emits a self-contained Bundle (build.py): globally-
// unique tree paths, server-computed complexity, the full metric_schema, and one
// RunRow per training run. There is NO browser-side analytics here — no
// complexity fill, no path re-keying, no chain resolution. The live data path
// (data/source.ts) fetches + gunzips the gzip blob and calls asBundle() to
// validate the parsed JSON against the pinned schema_version.

import type { Bundle } from "../lib/types";
import { SCHEMA_VERSION } from "../lib/types";

/** Validate that parsed JSON is a schema_version-pinned Bundle. Fails loud otherwise. */
export function asBundle(parsed: unknown): Bundle {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("snapshot is not an object");
  }
  const sv = (parsed as { schema_version?: unknown }).schema_version;
  if (sv !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported snapshot schema_version ${String(sv)} (expected ${SCHEMA_VERSION})`,
    );
  }
  return parsed as Bundle;
}
