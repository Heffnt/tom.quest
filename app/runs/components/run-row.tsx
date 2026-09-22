"use client";

// ONE ROW OF A RUN, AT THREE LEVELS (§23.6, and Tom 2026-09-10: "it should all
// be visible in a compact way such that I can click on parts of it to expand
// them for more info or the raw transcript text that the llm sees").
//
//   compact — one line: a fixed label, the facts that kind carries, a preview.
//   full    — the row's whole content, exactly as the record holds it. Never a
//             summary: thinking opens complete and uncut.
//   raw     — the row's provenance (file, line span, file version, parser
//             version, source kind, digest) and the stored entry itself, as
//             JSON. That entry is what the model saw, redacted at ingest, which
//             is what the store holds.
//
// A click cycles compact → full → raw → compact. TWO KINDS OF ROW ARE FULL
// ALREADY: `user` and `assistant-text` (and `error`, which is never folded).
// That is where §20.3's "all of the agent's natural language, in full" and
// Tom's "we don't want the chat interaction to be cluttered" meet — the
// conversation is what he is reading, the machinery is what clutters it. Those
// rows carry the raw level on their own small control instead of swallowing a
// click on prose he is trying to select.
//
// content is v.any() and now has THREE writers — the session daemon, the
// Claude run-file parser and the Codex run-file parser. Every reader here lives
// in ../lib and handles all the shapes it can meet; none of them throws.

import { useState } from "react";
import type { TranscriptMessage } from "../lib";
import {
  childRunOf,
  compactInput,
  contentToText,
  contextFactsOf,
  costText,
  durationText,
  errorTextOf,
  isErrorOf,
  modelOfTomHeadOf,
  persistedOutputOf,
  previewLine,
  thinkingTextOf,
  toolInputObjectOf,
  toolNameOf,
  toolResultTextOf,
  toolUseIdOf,
  truncationNoteOf,
} from "../lib";
import Markdown from "./markdown";
import OverflowExpand from "./overflow-expand";

/** Which query delivered this row — named at the raw level, never guessed. */
export type RowSource = "session" | "run";

/** A tool-result row that answers this tool-call, when both are loaded. */
export type PairedResult = {
  row: TranscriptMessage;
  /**
   * result.createdAt − call.createdAt, when both are positive and the result is
   * not earlier than the call. On a file-derived row createdAt is the file
   * line's own timestamp, so this is a measurement; on a daemon row it is the
   * INGEST time (the daemon batches a flush per ~400ms), so the number is
   * coarse there. Absent rather than negative.
   */
  durationMs?: number;
};

const PRE_CLASS =
  "mt-1 whitespace-pre-wrap break-words font-mono text-xs text-text-muted bg-surface-alt/50 border border-border rounded p-3 overflow-x-auto";

/** The file name alone: a full path is the raw level's business, not a line's. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts.length === 0 ? path : parts[parts.length - 1];
}

/**
 * What was cut, and the way back to it when there is one. Two halves: the note
 * the writer left, verbatim, and the control that reads the stored bytes back.
 *
 * THE CONTROL IS SESSION-ONLY. claudeSessions.getMessageOverflow refuses a row
 * with no sessionId (it is the session surface's door), and phase 4 adds no
 * second reader — so a run row says what the stamp says and offers nothing,
 * rather than a button that cannot fetch. Phase 5 owns the run-side reader.
 */
function Cut({ row }: { row: TranscriptMessage }) {
  const note = truncationNoteOf(row.content);
  if (note === undefined && row.hasOverflow !== true) return null;
  return (
    <div className="px-1">
      {note !== undefined && (
        <div className="mt-1 font-mono text-[10px] text-text-faint">{note}</div>
      )}
      {row.hasOverflow === true &&
        (row.sessionId !== undefined ? (
          <OverflowExpand
            messageId={row._id}
            fullByteLength={row.fullByteLength}
          />
        ) : (
          <div className="mt-1 font-mono text-[10px] text-text-faint">
            cut ·{" "}
            {row.fullByteLength === undefined
              ? "the whole payload is stored beside the row"
              : `${row.fullByteLength} bytes stored beside the row`}{" "}
            · no reader for a run row on this page
          </div>
        ))}
    </div>
  );
}

/**
 * WHAT THE SESSION BEGAN WITH. The opener is prepended with the model-of-tom
 * layers under one header line naming the WikiTom commit they were read at and
 * their paths (convex/ttsSkills.ts modelOfTomText). The row says it as a fact
 * of its own; the prompt still renders below in full, header line and all.
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
 * The third level. Provenance is what makes a row checkable against the file it
 * came from; a row written before its session's cutover has none, and says so
 * rather than showing an empty header.
 */
function Raw({ row, source }: { row: TranscriptMessage; source: RowSource }) {
  const p = row.provenance;
  return (
    <div className="mt-1 px-1">
      {p === undefined ? (
        <div className="font-mono text-[10px] text-text-faint">
          daemon row · no run file
        </div>
      ) : (
        <div className="font-mono text-[10px] text-text-faint break-words">
          <div>
            {basename(p.file)} · lines {p.lineStart}–{p.lineEnd} · block{" "}
            {p.block} · version {p.fileVersion.slice(0, 12)}
          </div>
          <div>
            parser {p.parserVersion} · source {p.sourceKind}
            {row.digest === undefined ? "" : ` · digest ${row.digest}`}
          </div>
        </div>
      )}
      <div className="font-mono text-[10px] text-text-faint">
        seq {row.seq} · read by{" "}
        {source === "session" ? "claudeSessions.getMessages" : "runs.rows"}
      </div>
      <pre className={PRE_CLASS}>{JSON.stringify(row.content, null, 2)}</pre>
    </div>
  );
}

/** The small control that opens the raw level on a row that is already full. */
function RawToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="mt-1 text-[11px] text-text-faint underline underline-offset-2 hover:text-text-muted"
    >
      {open ? "hide the stored entry" : "raw"}
    </button>
  );
}

type Compact = {
  label: string;
  labelTone?: string;
  facts: string[];
  preview: string;
};

/**
 * The compact line, per kind. `facts` are the things that kind always carries;
 * `preview` is the first of its text. An unrecognised kind is labelled with the
 * kind verbatim and previewed from its JSON — a runtime this page has never
 * seen still shows every row it wrote.
 */
function compactOf(
  row: TranscriptMessage,
  result: PairedResult | undefined,
  toolNames: ReadonlyMap<string, string> | undefined,
): Compact {
  const { kind, content } = row;
  switch (kind) {
    case "context": {
      const facts = contextFactsOf(content);
      return {
        label: "context",
        facts: [
          facts.model,
          facts.host,
          facts.cwd === undefined ? undefined : basename(facts.cwd),
          facts.layersKnown
            ? facts.layersGiven.join("+") || "no layers given"
            : "layers not known",
          `${facts.skillsUsed.length} skills`,
          `${facts.tools.length} tools`,
        ].filter((fact): fact is string => fact !== undefined),
        preview: previewLine(facts.prompt, 80),
      };
    }
    case "thinking": {
      const text = thinkingTextOf(content);
      return {
        label: "thinking",
        // Characters, not tokens: no per-row token figure exists anywhere in
        // the record (outcome.totals.thinkingTokens is the whole run's), and
        // dividing it across rows would put an invented number on the screen.
        facts: [`${text.length} chars`],
        preview: previewLine(text, 80),
      };
    }
    case "tool-call": {
      const name = toolNameOf(content);
      const input = toolInputObjectOf(content);
      const failed =
        result !== undefined && isErrorOf(result.row.content) ? "failed" : undefined;
      return {
        label: name,
        facts: [
          result?.durationMs === undefined
            ? undefined
            : durationText(result.durationMs),
          failed,
        ].filter((fact): fact is string => fact !== undefined),
        preview: previewLine(compactInput(name, input), 80),
      };
    }
    case "tool-result": {
      const failed = isErrorOf(content);
      const id = toolUseIdOf(content);
      const name = id === undefined ? undefined : toolNames?.get(id);
      return {
        label: failed ? "failed" : "→",
        labelTone: failed ? "text-error" : undefined,
        facts: name === undefined ? [] : [name],
        preview: previewLine(toolResultTextOf(content), 80),
      };
    }
    case "child-run": {
      const child = childRunOf(content);
      return {
        label: "child",
        facts: [
          child?.agentType,
          child?.model,
          child?.status,
          child?.totalTokens === undefined ? undefined : `${child.totalTokens} tok`,
        ].filter((fact): fact is string => fact !== undefined),
        preview: previewLine(
          child?.description ?? child?.childRunId ?? contentToText(content),
          80,
        ),
      };
    }
    case "permission": {
      // The permission table is retired and nothing produces these any more
      // (§20.2). The rows that exist are history, and the record never hides a
      // row it holds — so it renders as one line and gets no card.
      return {
        label: "permission",
        facts: [toolNameOf(content)],
        preview: previewLine(contentToText(content), 80),
      };
    }
    case "system": {
      return {
        label: "system",
        facts:
          row.provenance === undefined ? [] : [row.provenance.sourceKind],
        preview: previewLine(contentToText(content), 120),
      };
    }
    default: {
      return {
        label: String(kind),
        facts: [],
        preview: previewLine(contentToText(content), 80),
      };
    }
  }
}

/** The full level's body for a kind that is compact by default. */
function fullBody(
  row: TranscriptMessage,
  result: PairedResult | undefined,
): string {
  const { kind, content } = row;
  switch (kind) {
    case "thinking":
      return thinkingTextOf(content);
    case "tool-call": {
      const name = toolNameOf(content);
      const input = compactInput(name, toolInputObjectOf(content));
      if (result === undefined) return input;
      return `${input}\n\n→\n${toolResultTextOf(result.row.content)}`;
    }
    case "tool-result":
      return toolResultTextOf(content);
    case "context":
      return contextFactsOf(content).prompt || contentToText(content);
    default:
      return contentToText(content);
  }
}

export default function RunRow({
  row,
  result,
  toolNames,
  source,
}: {
  row: TranscriptMessage;
  /** The tool-result this call consumed, when both are in the loaded window. */
  result?: PairedResult;
  /** toolUseId → toolName over the loaded window, so an unpaired result can
   *  name the call it answers. Absent when that call has been paged out — the
   *  row then shows no name rather than a guessed one. */
  toolNames?: ReadonlyMap<string, string>;
  source: RowSource;
}) {
  const [level, setLevel] = useState<0 | 1 | 2>(0);
  const { kind, content } = row;
  const cut = <Cut row={row} />;
  const raw = level === 2 ? <Raw row={row} source={source} /> : null;
  const rawToggle = (
    <RawToggle
      open={level === 2}
      onClick={() => setLevel(level === 2 ? 0 : 2)}
    />
  );

  // ── The three kinds that are full already ────────────────────────────────
  if (kind === "user") {
    const text = contentToText(content);
    return (
      <div className="border-l-2 border-accent bg-surface-alt/40 rounded-r px-3 py-2 ml-6 sm:ml-16">
        <ModelOfTomHead text={text} />
        <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text">
          {text}
        </pre>
        {cut}
        {rawToggle}
        {raw}
      </div>
    );
  }
  if (kind === "assistant-text") {
    return (
      <div className="px-1">
        <Markdown text={contentToText(content)} />
        {cut}
        {rawToggle}
        {raw}
      </div>
    );
  }
  if (kind === "error") {
    return (
      <div className="border border-error/40 rounded px-3 py-2">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm text-error">
          {errorTextOf(content)}
        </pre>
        {cut}
        {rawToggle}
        {raw}
      </div>
    );
  }

  // ── Everything else: one line, opening to full, then to raw ──────────────
  const compact = compactOf(row, result, toolNames);
  const persisted =
    result === undefined ? persistedOutputOf(content) : persistedOutputOf(result.row.content);
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setLevel(level === 0 ? 1 : level === 1 ? 2 : 0)}
        aria-expanded={level > 0}
        className="w-full text-left cursor-pointer flex items-baseline gap-2 px-2 py-1 rounded text-text-faint hover:bg-surface-alt/50"
      >
        <span
          className={`shrink-0 font-mono text-xs ${compact.labelTone ?? "text-text-muted"}`}
        >
          {compact.label}
        </span>
        {compact.facts.map((fact) => (
          <span
            key={fact}
            className={`shrink-0 font-mono text-xs ${fact === "failed" ? "text-error" : "text-text-faint"}`}
          >
            {fact}
          </span>
        ))}
        <span className="truncate min-w-0">{compact.preview}</span>
      </button>
      {level >= 1 && (
        <>
          <pre className={PRE_CLASS}>{fullBody(row, result)}</pre>
          {persisted !== null && (
            // A Claude tool result too large for the transcript points at a
            // file on the Jarvis Box. Nothing serves that file, so this is a
            // fact line and never a link.
            <div className="px-1 mt-1 font-mono text-[10px] text-text-faint break-words">
              persisted output ·{" "}
              {persisted.path === undefined ? "path not recorded" : basename(persisted.path)}
              {persisted.sizeText === undefined ? "" : ` · ${persisted.sizeText}`}
              {persisted.bytes === undefined ? "" : ` · ${persisted.bytes} bytes`}
            </div>
          )}
          {cut}
          {result !== undefined && <Cut row={result.row} />}
        </>
      )}
      {raw}
      {/* A paired row holds two stored entries, so the raw level shows both,
          each naming its own seq. */}
      {level === 2 && result !== undefined && (
        <Raw row={result.row} source={source} />
      )}
    </div>
  );
}

export { costText };
