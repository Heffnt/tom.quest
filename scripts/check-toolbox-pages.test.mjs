import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checkPageSource, checkToolboxPages, checkToolboxSource } from "./check-toolbox-pages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A page that keeps every rule; each case below breaks one. */
const CLEAN = `"use client";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import TomGate from "@/app/components/tom-gate";
import { Page, PageHead, Num, useSurfaceQuery } from "@/app/components/toolbox";
import { shapeCells } from "@/app/tts/lib";
import Other from "./other";

export default function Clean() {
  const todos = useSurfaceQuery("TTS", api.tts.listTodos, {});
  const [n] = useState(0);
  const late = todos?.filter((t) => t.dueAt !== undefined).length;
  return (
    <TomGate label="TTS">
      <Page>
        <PageHead name="clean" sentence={<><Num>{late}</Num> todos with a date</>} caption="tts.listTodos → counts" />
        {shapeCells([], n).map((c) => <Num key={c.key}>{c.count}</Num>)}
        <Other />
      </Page>
    </TomGate>
  );
}
`;

const broken = (from, to) => {
  expect(CLEAN).toContain(from);
  return checkPageSource("app/x/page.tsx", CLEAN.replace(from, to));
};

describe("check-toolbox-pages: a page file", () => {
  it("passes a page that composes the toolbox", () => {
    expect(checkPageSource("app/x/page.tsx", CLEAN)).toEqual([]);
  });

  it("fails a className or style attribute", () => {
    expect(broken("<Page>", '<Page className="p-4">').join()).toContain("a className attribute");
    expect(broken("<Page>", "<Page style={{ padding: 4 }}>").join()).toContain("a style attribute");
  });

  it("fails a colour literal and a font size", () => {
    expect(broken('name="clean"', 'name="#e8a040"').join()).toContain("a colour literal");
    expect(broken('name="clean"', 'name="rgb(1, 2, 3)"').join()).toContain("a colour literal");
    expect(broken("const [n] = useState(0);", "const [n] = useState(0); const s = { fontSize: 12 };").join()).toContain("a font size");
  });

  it("fails an import from outside the toolbox, its queries and a sibling", () => {
    expect(broken('from "./other"', 'from "@/app/tts/components/info"').join()).toContain('imports "@/app/tts/components/info"');
    expect(broken('from "./other"', 'from "./nested/other"').join()).toContain("not a sibling");
    expect(broken('from "./other"', 'from "../other"').join()).toContain('imports "../other"');
  });

  it("fails a component of its own", () => {
    const extra = CLEAN + "\nfunction Card() { return <div />; }\nconst Chip = () => <span />;\n";
    const errors = checkPageSource("app/x/page.tsx", extra).join("\n");
    expect(errors).toContain("defines the component Card");
    expect(errors).toContain("defines the component Chip");
  });

  it("fails a refused word in a string or JSX text, and not in code", () => {
    expect(broken("todos with a date", "todos in this environment").join()).toContain('"environment"');
    expect(broken('name="clean"', 'name="readiness"').join()).toContain('"readiness"');
    for (const word of ["dueAt", "createdAt", "wakeAt", "timingClass", "updatedAt"]) {
      expect(broken("todos with a date", word).join()).toContain(`"${word}"`);
    }
    // t.dueAt above is a property read, which is code, not a word on the page.
    expect(checkPageSource("app/x/page.tsx", CLEAN)).toEqual([]);
  });
});

describe("check-toolbox-pages: the toolbox", () => {
  it("passes token reads and fails literals, off-scale sizes, gradients and shadows", () => {
    expect(checkToolboxSource("t.css", ".a { color: var(--color-text); font-size: var(--tb-text-2); box-shadow: none; }")).toEqual([]);
    expect(checkToolboxSource("t.css", ".a { color: #fff; }").join()).toContain("a colour literal");
    expect(checkToolboxSource("t.css", ".a { font-size: 12px; }").join()).toContain("font-size 12px");
    expect(checkToolboxSource("t.css", ".a { background: linear-gradient(red, blue); }").join()).toContain("a gradient");
    expect(checkToolboxSource("t.css", ".a { box-shadow: 0 1px 2px black; }").join()).toContain("a shadow");
    expect(checkToolboxSource("t.tsx", "<text fontSize={10} />").join()).toContain("a fontSize");
  });

  it("reads no comment as code", () => {
    expect(checkToolboxSource("t.css", "/* no #fff, no font-size: 9px */\n.a { color: var(--color-text); }")).toEqual([]);
  });
});

describe("check-toolbox-pages: this checkout", () => {
  it("passes app/toolbox and the toolbox", () => {
    expect(checkToolboxPages(ROOT)).toEqual({ code: 0, errors: [] });
  });

  it("fails a listed page directory that holds no page", () => {
    expect(checkToolboxPages(ROOT, ["app/no-such-page"]).errors.join()).toContain("holds no page file");
  });
});
