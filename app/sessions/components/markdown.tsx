"use client";

// A minimal markdown renderer for transcript prose. The agent writes markdown;
// rendering it as a raw <pre> showed the syntax instead of the meaning.
//
// Dependency-free and element-based ON PURPOSE: no library (the repo carries no
// markdown dep and scripts/check-heavy-libs polices bundle weight) and no
// dangerouslySetInnerHTML (transcript text is model output — it never becomes
// markup).
//
// SUPPORTED: # ## ### #### headings, paragraphs, - / * and 1. lists, ```fenced
// code (optional language tag), `inline code`, **bold**, *italic*,
// [text](http(s) url), > blockquote.
// DELIBERATELY NOT SUPPORTED — rendered as the plain text they are: tables,
// images, raw HTML, footnotes, setext headings, nested lists, reference links,
// strikethrough. Unmatched or half-typed syntax (a fence still streaming, a
// bracket with no url) degrades to plain text; nothing here can throw.

import type { ReactNode } from "react";

// One pass over the inline grammar. Order matters: ** is tried before *, and a
// code span wins over everything inside it. Emphasis requires a non-space right
// after the opening marker, so arithmetic ("2 * 3 * 4") stays arithmetic.
const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^\s][^\n]*?\*\*)|(\*[^\s*][^*\n]*?\*)|(\[[^\]\n]*\]\([^()\s]*\))/g;

/** http(s) only. Anything else (javascript:, data:, mailto:, relative) is text. */
function isWebHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** Inline spans inside one block of text. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(text); m !== null; m = INLINE_RE.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const id = `${key}-${n++}`;
    if (m[1] !== undefined) {
      out.push(
        <code
          key={id}
          className="font-mono text-xs bg-surface-alt/70 rounded px-1 py-0.5"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(
        <strong key={id} className="font-semibold text-text">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (m[3] !== undefined) {
      out.push(
        <em key={id} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    } else {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      out.push(
        isWebHref(href) ? (
          <a
            key={id}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2 break-words"
          >
            {label === "" ? href : label}
          </a>
        ) : (
          token
        ),
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING_CLASS = [
  "text-base font-semibold text-text mt-2",
  "text-sm font-semibold text-text mt-2",
  "text-sm font-semibold text-text-muted mt-1",
  "text-xs font-semibold text-text-muted mt-1",
];

const FENCE_RE = /^\s*```(.*)$/;
const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;

function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line)
  );
}

function renderBlocks(src: string): ReactNode[] {
  const lines = src.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i += 1;
      // An unterminated fence (text still streaming in) renders what exists.
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closing fence, if there was one
      out.push(
        <div
          key={key}
          className="relative bg-surface-alt/60 border border-border rounded"
        >
          {lang !== "" && (
            <span className="absolute top-1 right-2 font-mono text-[10px] text-text-faint">
              {lang}
            </span>
          )}
          {/* Code scrolls itself: the page body must never scroll sideways. */}
          <pre className="overflow-x-auto whitespace-pre font-mono text-xs text-text-muted p-3">
            {body.join("\n")}
          </pre>
        </div>,
      );
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      out.push(
        <div key={key} className={`${HEADING_CLASS[level - 1]} break-words`}>
          {inline(heading[2], key)}
        </div>,
      );
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      for (let q = QUOTE_RE.exec(lines[i]); q !== null; ) {
        body.push(q[1]);
        i += 1;
        q = i < lines.length ? QUOTE_RE.exec(lines[i]) : null;
      }
      out.push(
        <div
          key={key}
          className="border-l-2 border-border pl-3 text-text-muted whitespace-pre-wrap break-words"
        >
          {inline(body.join("\n"), key)}
        </div>,
      );
      continue;
    }

    // Lists are flat by design — a nested bullet renders as one more item, its
    // indentation preserved by nothing, which is honest enough for prose.
    const listRe = UL_RE.test(line) ? UL_RE : OL_RE.test(line) ? OL_RE : null;
    if (listRe !== null) {
      const items: string[] = [];
      for (let it = listRe.exec(lines[i]); it !== null; ) {
        items.push(it[1]);
        i += 1;
        it = i < lines.length ? listRe.exec(lines[i]) : null;
      }
      const children = items.map((item, n) => (
        <li key={`${key}-${n}`}>{inline(item, `${key}-${n}`)}</li>
      ));
      out.push(
        listRe === OL_RE ? (
          <ol key={key} className="list-decimal pl-5 space-y-0.5 break-words">
            {children}
          </ol>
        ) : (
          <ul key={key} className="list-disc pl-5 space-y-0.5 break-words">
            {children}
          </ul>
        ),
      );
      continue;
    }

    // Paragraph: run to the next blank line or block start. Single newlines are
    // kept (whitespace-pre-wrap) — the agent's line breaks are meaningful.
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(
      <p key={key} className="whitespace-pre-wrap break-words">
        {inline(para.join("\n"), key)}
      </p>,
    );
  }
  return out;
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="text-sm text-text space-y-2 break-words">
      {renderBlocks(text)}
    </div>
  );
}
