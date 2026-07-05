// Share-URL state codec: a link must reproduce the exact view; a mangled
// param must degrade to the default view (null), never throw.

import { describe, it, expect } from "vitest";
import { encodeSharedView, decodeSharedView, type SharedView } from "./share";
import { DEFAULT_ANATOMY, DEFAULT_CHART, EMPTY_FILTER } from "./types";

describe("share codec", () => {
  it("round-trips a full view (unicode-safe)", () => {
    const view: SharedView = {
      filters: {
        ...EMPTY_FILTER,
        facets: { baseModel: ["Qwen/Qwen2.5-0.5B-Instruct"] },
        ranges: [{ metric: "avg_sensitivity", min: 0.5, max: 1.2 }],
        status: ["plantedOnly"],
        search: "3:E8 ⊕",
      },
      sorts: [{ col: "headline.plantedness", dir: "desc" }],
      visibleCols: ["function.arity", "function.fn_hex"],
      chart: { ...DEFAULT_CHART, y: "asr", logX: true, trend: true },
      view: "chart",
    };
    const decoded = decodeSharedView(encodeSharedView(view));
    expect(decoded).toEqual(view);
  });

  it("round-trips an anatomy view (focus weights + twin + selection)", () => {
    const view: SharedView = {
      anatomy: {
        ...DEFAULT_ANATOMY,
        focus: { L17: 30, "L17/attn/h9": 900 },
        twin: false,
        sel: "cde:L17/attn/h9",
      },
      view: "anatomy",
    };
    const decoded = decodeSharedView(encodeSharedView(view));
    expect(decoded).toEqual(view);
  });

  it("the encoded param is URL-safe (no + / = characters)", () => {
    const p = encodeSharedView({ view: "table" });
    expect(p).not.toMatch(/[+/=]/);
  });

  it("garbage decodes to null, never throws", () => {
    expect(decodeSharedView("not-base64!!!")).toBeNull();
    expect(decodeSharedView("")).toBeNull();
    // valid base64 of a non-object
    expect(decodeSharedView(Buffer.from("42").toString("base64url"))).toBeNull();
  });
});
