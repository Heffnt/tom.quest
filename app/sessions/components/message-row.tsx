"use client";

// One finalized transcript row, rendered by kind.
//
// THE RULE (ratified 2026-08-29): every word of natural language the agent
// produced — assistant text AND thinking — is on screen in full, always. Only
// machine traffic (tool calls, tool results) is compacted to one line with an
// expand. Content is v.any(): the per-kind readers live in ../lib and each one
// knows the daemon's shape for its kind, so no row ever renders as the
// serialized wrapper around its own payload.

import type { TranscriptMessage } from "../lib";
import {
  compactInput,
  contentToText,
  errorTextOf,
  isErrorOf,
  modelOfTomHeadOf,
  previewLine,
  toolInputOf,
  toolNameOf,
  toolResultTextOf,
  truncationNoteOf,
  toolUseIdOf,
} from "../lib";
import Markdown from "./markdown";
import OverflowExpand from "./overflow-expand";

/**
 * What the daemon cut, and the way back to it. Two halves, and a row can carry
 * either: the note the daemon wrote about the cut, verbatim and never
 * paraphrased, and — when the whole payload was stored beside the row
 * (`hasOverflow`) — the control that reads it back (./overflow-expand). The
 * rule this surface has is that everything the session did is on screen in
 * full; a cut with no way past it was the one place that was not true.
 */
function Cut({ message }: { message: TranscriptMessage }) {
  const note = truncationNoteOf(message.content);
  if (note === undefined && message.hasOverflow !== true) return null;
  return (
    <div className="px-1">
      {note !== undefined && (
        <div className="mt-1 font-mono text-[10px] text-text-faint">{note}</div>
      )}
      {message.hasOverflow === true && (
        <OverflowExpand
          messageId={message._id}
          fullByteLength={message.fullByteLength}
        />
      )}
    </div>
  );
}

/**
 * WHAT THE SESSION BEGAN WITH (the lifeos update, phase 7). This opener is
 * prepended with the caller-selected model-of-tom layers — the WikiTom pages
 * that opener needs — under one header line naming the commit they were read at and
 * listing their paths (convex/ttsSkills.ts modelOfTomText). That header is the
 * transcript's record of it, so the row it arrives on says it as a fact of its
 * own: which commit, and which files. The prompt itself still renders below,
 * in full, header line and all.
 */
function ModelOfTomHead({ text }: { text: string }) {
  const head = modelOfTomHeadOf(text);
  if (head === null) return null;
  return (
    <div className="mb-1.5 border-b border-border pb-1.5 font-mono text-[10px] text-text-faint">
      <div>
        model-of-tom ·{" "}
        {head.commit === null
          ? "no WikiTom commit recorded"
          : `WikiTom commit ${head.commit}`}
      </div>
      {head.paths.length > 0 && (
        <div className="break-words">{head.paths.join(" · ")}</div>
      )}
    </div>
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
  cut,
}: {
  label: string;
  labelTone?: string;
  suffix?: string;
  preview: string;
  body: string;
  /** The cut footer, if this row carries one (see Cut). */
  cut?: React.ReactNode;
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
      {cut}
    </details>
  );
}

function stringField(content: unknown, key: string): string | undefined {
  if (typeof content !== "object" || content === null) return undefined;
  const value = (content as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stringListField(content: unknown, key: string): string[] {
  if (typeof content !== "object" || content === null) return [];
  const value = (content as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export default function MessageRow({
  message,
  toolNames,
}: {
  message: TranscriptMessage;
  // toolUseId → toolName, built by the transcript from the loaded tool-call
  // rows. Absent when the matching call has not been paged in — the row then
  // shows no name rather than a guessed one.
  toolNames?: ReadonlyMap<string, string>;
}) {
  const { kind, content } = message;
  const cut = <Cut message={message} />;

  switch (kind) {
    case "user": {
      const text = contentToText(content);
      return (
        <div className="border-l-2 border-accent bg-surface-alt/40 rounded-r px-3 py-2 ml-6 sm:ml-16">
          <ModelOfTomHead text={text} />
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text">
            {text}
          </pre>
          {cut}
        </div>
      );
    }
    case "assistant-text": {
      return (
        <div className="px-1">
          <Markdown text={contentToText(content)} />
          {cut}
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
          {cut}
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
          cut={cut}
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
          cut={cut}
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
            {cut}
          </details>
        );
      }
      return (
        <div className="text-center text-xs text-text-faint px-1">
          {mark}
          {preview}
          {cut}
        </div>
      );
    }
    case "error": {
      return (
        <div className="border border-error/40 rounded px-3 py-2">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-error">
            {errorTextOf(content)}
          </pre>
          {cut}
        </div>
      );
    }
    case "context": {
      const model = stringField(content, "model") ?? stringField(content, "modelRequested");
      const layers = stringListField(content, "layersGiven");
      const cwd = stringField(content, "cwd");
      const preview = [
        model && `model ${model}`,
        layers.length > 0 && `layers ${layers.join(", ")}`,
        cwd && `cwd ${cwd}`,
      ].filter((part): part is string => typeof part === "string").join(" · ");
      const body = contentToText(content);
      return (
        <CollapsedRow
          label="context"
          preview={preview || previewLine(body)}
          body={body}
          cut={cut}
        />
      );
    }
    case "child-run": {
      const agentType = stringField(content, "agentType") ?? stringField(content, "agentId") ?? "child run";
      const model = stringField(content, "model");
      const status = stringField(content, "status");
      const childRunId = stringField(content, "childRunId");
      const body = contentToText(content);
      return (
        <CollapsedRow
          label={agentType}
          suffix={model}
          preview={[status, childRunId].filter((part): part is string => part !== undefined).join(" · ") || previewLine(body)}
          body={body}
          cut={cut}
        />
      );
    }
    default: {
      const body = contentToText(content);
      return (
        <CollapsedRow
          label={String(kind)}
          preview={previewLine(body)}
          body={body}
          cut={cut}
        />
      );
    }
  }
}
