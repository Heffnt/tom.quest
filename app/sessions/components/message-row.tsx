"use client";

// One finalized transcript row, rendered by kind.
//
// THE RULE (ratified 2026-08-29): every word of natural language the agent
// produced — assistant text AND thinking — is on screen in full, always. Only
// machine traffic (tool calls, tool results) is compacted to one line with an
// expand. Content is v.any(): the per-kind readers live in ../lib and each one
// knows the daemon's shape for its kind, so no row ever renders as the
// serialized wrapper around its own payload.

import type { Message } from "../lib";
import {
  compactInput,
  contentToText,
  errorTextOf,
  isErrorOf,
  previewLine,
  toolInputOf,
  toolNameOf,
  toolResultTextOf,
  truncationNoteOf,
  toolUseIdOf,
} from "../lib";
import Markdown from "./markdown";

/** The daemon's verbatim note about a payload it cut — never paraphrased. */
function TruncationNote({ note }: { note: string | undefined }) {
  if (note === undefined) return null;
  return (
    <div className="mt-1 font-mono text-[10px] text-text-faint px-1">{note}</div>
  );
}

/**
 * Machine traffic: one line by default, full payload on tap. `tone` colors the
 * label — error results say "failed" in the error color.
 */
function CollapsedRow({
  label,
  labelTone,
  suffix,
  preview,
  body,
  note,
}: {
  label: string;
  labelTone?: string;
  suffix?: string;
  preview: string;
  body: string;
  note?: string;
}) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer list-none flex items-baseline gap-2 px-2 py-1 rounded text-text-faint hover:bg-surface-alt/50">
        <span
          className={`shrink-0 font-mono text-xs ${labelTone ?? "text-text-muted"}`}
        >
          {label}
        </span>
        {suffix !== undefined && (
          <span className="shrink-0 font-mono text-xs text-text-faint">
            {suffix}
          </span>
        )}
        <span className="truncate min-w-0">{preview}</span>
      </summary>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-text-muted bg-surface-alt/50 border border-border rounded p-3 overflow-x-auto">
        {body}
      </pre>
      <TruncationNote note={note} />
    </details>
  );
}

export default function MessageRow({
  message,
  toolNames,
}: {
  message: Message;
  // toolUseId → toolName, built by the transcript from the loaded tool-call
  // rows. Absent when the matching call has not been paged in — the row then
  // shows no name rather than a guessed one.
  toolNames?: ReadonlyMap<string, string>;
}) {
  const { kind, content } = message;
  const note = truncationNoteOf(content);

  switch (kind) {
    case "user": {
      return (
        <div className="border-l-2 border-accent bg-surface-alt/40 rounded-r px-3 py-2 ml-6 sm:ml-16">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text">
            {contentToText(content)}
          </pre>
          <TruncationNote note={note} />
        </div>
      );
    }
    case "assistant-text": {
      return (
        <div className="px-1">
          <Markdown text={contentToText(content)} />
          <TruncationNote note={note} />
        </div>
      );
    }
    case "thinking": {
      // Full text, no fold: thinking is the agent's reasoning, and hiding it
      // was the loudest complaint. Muted + a left rule keeps it visually
      // secondary without taking it away.
      return (
        <div className="border-l border-border pl-3 py-0.5">
          <div className="font-mono text-[10px] text-text-faint/70">
            thinking
          </div>
          <pre className="whitespace-pre-wrap break-words font-sans text-xs text-text-faint">
            {contentToText(content)}
          </pre>
          <TruncationNote note={note} />
        </div>
      );
    }
    case "tool-call": {
      const name = toolNameOf(content);
      const input = toolInputOf(content);
      const body = compactInput(name, input);
      return (
        <CollapsedRow
          label={name}
          preview={previewLine(body)}
          body={body}
          note={note}
        />
      );
    }
    case "tool-result": {
      const failed = isErrorOf(content);
      const id = toolUseIdOf(content);
      const name = id === undefined ? undefined : toolNames?.get(id);
      const text = toolResultTextOf(content);
      return (
        <CollapsedRow
          label={failed ? "failed" : "→"}
          labelTone={failed ? "text-error" : undefined}
          suffix={name}
          preview={previewLine(text)}
          body={text}
          note={note}
        />
      );
    }
    case "permission": {
      return (
        <div className="text-xs text-text-faint px-1">
          permission requested: {toolNameOf(content)}
        </div>
      );
    }
    case "system": {
      // source "sdk" = the SDK spoke on its own (background-task
      // notifications), not the daemon narrating. The mark says which.
      const fromSdk =
        typeof content === "object" &&
        content !== null &&
        (content as Record<string, unknown>).source === "sdk";
      const text = contentToText(content);
      const preview = previewLine(text, 160);
      const mark = fromSdk ? (
        <span className="font-mono text-[10px] text-text-faint/70 mr-1.5">
          sdk
        </span>
      ) : null;
      // These are the honesty rows (workspace rebuilt, turn interrupted,
      // account switched). A long one gets an expand rather than a silent cut.
      const flat = text.replace(/\s+/g, " ").trim();
      if (preview !== flat) {
        return (
          <details className="text-center text-xs text-text-faint px-1">
            <summary className="cursor-pointer list-none hover:text-text-muted">
              {mark}
              {preview}
            </summary>
            <pre className="mt-1 text-left whitespace-pre-wrap break-words font-sans text-xs text-text-faint">
              {text}
            </pre>
            <TruncationNote note={note} />
          </details>
        );
      }
      return (
        <div className="text-center text-xs text-text-faint px-1">
          {mark}
          {preview}
          <TruncationNote note={note} />
        </div>
      );
    }
    case "error": {
      return (
        <div className="border border-error/40 rounded px-3 py-2">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-error">
            {errorTextOf(content)}
          </pre>
          <TruncationNote note={note} />
        </div>
      );
    }
  }
}
