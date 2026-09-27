import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findExplainers, renderExplainerModules } from "../../../scripts/gen-explainers.mjs";

const ROOT = path.resolve(__dirname, "../../..");

describe("explainer registry", () => {
  const files = (findExplainers(ROOT) as string[]).map((p) => ({ path: p, html: fs.readFileSync(path.join(ROOT, p), "utf8") }));

  it("is what scripts/gen-explainers.mjs writes (run pnpm gen:explainers)", () => {
    const out = renderExplainerModules(files) as Map<string, string>;
    for (const [rel, content] of out) {
      expect(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel).toBe(content);
    }
    const generated = fs.readdirSync(path.join(ROOT, "app/components/frame/explainers")).filter((n) => n.endsWith(".generated.ts"));
    expect(generated.length).toBe(files.length);
  });

  it.each(files.map((f) => [f.path, f.html]))("%s is one self-contained page", (_p, html) => {
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/);
  });
});
