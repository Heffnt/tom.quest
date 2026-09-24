// check-toolbox-pages.mjs — a Jarvis page is a composition of the toolbox, and
// the toolbox writes no colour or size of its own (vqc/pages.md, principles 6,
// 7 and 9; Tom, 2026-09-24: "strict rules around how pages can be designed so
// that it is impossible for agents to build a tom.quest page that I don't
// find visually appealing").
// NO SHEBANG LINE, for check-writing-standard.mjs's reason: the test beside it
// imports this file. `pnpm check:guardrails` runs `node
// scripts/check-toolbox-pages.mjs`.
//
// A PAGE FILE — every .ts/.tsx under a TOOLBOX_PAGES entry — fails on:
//   - a `className` or `style` attribute (principle 9: no style of its own);
//   - a hex, rgb or hsl colour literal, or a font size (principle 7);
//   - an import from anywhere but the toolbox, its queries, the TTS selectors,
//     React, Next, the Tom gate and a sibling file in the same directory;
//   - a component of its own: a function that returns JSX, other than the
//     file's default export (principle 9);
//   - a refused word in a string or JSX text: "environment", or one of the
//     raw field names Tom has seen leak onto a page (principle 6).
//
// THE TOOLBOX — app/components/toolbox — fails on a hex, rgb or hsl literal
// anywhere, a font size that is not one of the five --tb-text-* tokens, and a
// gradient or shadow. Its colours and sizes are defined once, in
// app/globals.css, and read by name.
//
// It parses with the TypeScript compiler rather than matching text, so a word
// in a comment or a property read (`todo.dueAt`) is not a string on a page.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The page directories and files the page rules apply to. A page built from
 *  the toolbox joins this list in the commit that builds it. */
const TOOLBOX_PAGES = ["app/toolbox"];

const TOOLBOX_DIR = "app/components/toolbox";

/** Where a page file may import from. A sibling (`./x`) is checked apart. */
const ALLOWED_IMPORTS = [
  /^@\/app\/components\/toolbox$/,
  /^convex\/react$/,
  /^@\/convex\/_generated\/.+$/,
  /^react$/,
  /^next$/,
  /^next\/.+$/,
  /^@\/app\/components\/tom-gate$/,
  // The TTS selectors: derivations over query results, no component in it.
  /^@\/app\/tts\/lib$/,
];

const REFUSED_WORDS = [
  /\benvironment\b/i,
  /\bdueAt\b/,
  /\bcreatedAt\b/,
  /\bwakeAt\b/,
  /\btimingClass\b/,
  /\breadiness\b/,
  /\bupdatedAt\b/,
];

const COLOUR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\s*\(/;
const FONT_SIZE = /font-?size/i;

function jsxInside(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    // A nested function's JSX is that function's, not this one's.
    if (n !== node && ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function isDefaultExport(node) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
    mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

/** Every rule a page file breaks, as `file:line: what`. */
export function checkPageSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const errors = [];
  const at = (node, what) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    errors.push(`${file}:${line + 1}: ${what}`);
  };
  const specifier = (node, spec) => {
    if (spec.startsWith("./")) {
      if (spec.slice(2).includes("/")) at(node, `imports "${spec}", which is not a sibling in the page's directory`);
      return;
    }
    if (!ALLOWED_IMPORTS.some((re) => re.test(spec))) {
      at(node, `imports "${spec}"; a page imports only the toolbox, its queries and a sibling`);
    }
  };
  const words = (node, value) => {
    for (const re of REFUSED_WORDS) {
      const m = value.match(re);
      if (m) at(node, `the word "${m[0]}" is on the page`);
    }
    if (COLOUR.test(value)) at(node, "a colour literal; colours are the toolbox's");
    if (FONT_SIZE.test(value)) at(node, "a font size; sizes are the toolbox's");
  };

  // Components of its own: top-level functions returning JSX, bar the default export.
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && !isDefaultExport(stmt) && jsxInside(stmt)) {
      at(stmt, `defines the component ${stmt.name?.text ?? "(anonymous)"}; add it to the toolbox instead`);
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (d.initializer && ts.isFunctionLike(d.initializer) && jsxInside(d.initializer)) {
          at(d, `defines the component ${d.name.getText(source)}; add it to the toolbox instead`);
        }
      }
    }
  }

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier(node, node.moduleSpecifier.text);
      }
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteral(arg)) specifier(node, arg.text);
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (name === "className" || name === "style") at(node, `a ${name} attribute; a page styles nothing`);
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      FONT_SIZE.test(node.name.getText(source))
    ) {
      at(node, "a font size; sizes are the toolbox's");
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      words(node, node.text);
    }
    if (ts.isJsxText(node)) words(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
}

/** Every literal colour, off-scale font size, gradient or shadow in a toolbox
 *  file. CSS and TSX alike: a component's inline SVG is held to the same. */
export function checkToolboxSource(file, text) {
  const errors = [];
  // A comment may name what the file refuses; only code is held to it. Block
  // comments are blanked in place, so every line keeps its number.
  const blank = (m) => m.replace(/[^\n]/g, " ");
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:"'])\/\/.*$/gm, (m, lead) => lead);
  stripped.split("\n").forEach((code, i) => {
    const where = `${file}:${i + 1}`;
    if (COLOUR.test(code)) errors.push(`${where}: a colour literal; read a colour token from app/globals.css`);
    const size = code.match(/font-size\s*:\s*([^;]+)/i);
    if (size && !/^var\(--tb-text-[1-5]\)$/.test(size[1].trim())) {
      errors.push(`${where}: font-size ${size[1].trim()}; use one of var(--tb-text-1) to var(--tb-text-5)`);
    }
    if (/\bfontSize\b/.test(code)) errors.push(`${where}: a fontSize in a component; sizes live in toolbox.css`);
    if (/gradient\s*\(/i.test(code)) errors.push(`${where}: a gradient`);
    const shadow = code.match(/(box-shadow|text-shadow|drop-shadow)\s*[:(]\s*([^;]*)/i);
    if (shadow && !(shadow[1] !== "drop-shadow" && shadow[2].trim() === "none")) {
      errors.push(`${where}: a shadow`);
    }
  });
  return errors;
}

function filesUnder(root, rel, pattern) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return pattern.test(full) ? [rel] : [];
  return fs
    .readdirSync(full)
    .flatMap((name) => filesUnder(root, path.join(rel, name), pattern));
}

/** The whole check over a checkout: `{ code, errors }`. */
export function checkToolboxPages(root, pages = TOOLBOX_PAGES, toolboxDir = TOOLBOX_DIR) {
  const errors = [];
  const source = /\.(ts|tsx)$/;
  for (const entry of pages) {
    const files = filesUnder(root, entry, source).filter((f) => !/\.test\.tsx?$/.test(f));
    if (files.length === 0) errors.push(`${entry}: listed in TOOLBOX_PAGES and holds no page file`);
    for (const file of files) {
      errors.push(...checkPageSource(file, fs.readFileSync(path.join(root, file), "utf8")));
    }
  }
  const toolbox = filesUnder(root, toolboxDir, /\.(css|ts|tsx)$/).filter((f) => !/\.test\.tsx?$/.test(f));
  for (const file of toolbox) {
    errors.push(...checkToolboxSource(file, fs.readFileSync(path.join(root, file), "utf8")));
  }
  return { code: errors.length > 0 ? 1 : 0, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { code, errors } = checkToolboxPages(root);
  for (const e of errors) console.error(e);
  if (code === 0) console.log(`toolbox pages: ${TOOLBOX_PAGES.join(", ")} compose the toolbox; the toolbox reads only tokens`);
  process.exit(code);
}
