"use client";

// THE options surface for every /dts subject — a life todo, a batch (a batch
// IS a life todo) or a code item. One compact wrap row at the top of an
// expanded panel: the four verdict chips, the status chips a life todo carries
// (done · archive) and the importance setter.
//
// The four verdicts are uniform (ratified 2026-08-29): clicking a chip selects
// it and reveals ONE note input; confirming records the verdict with that note
// as `sentence`. Only revise requires it. On archive the sentence IS the
// unarchive condition (convex/dtsRulings.ts maps it), so one input serves all
// four.
//
// This one component replaces VerdictButtons, StatusActions and
// ImportanceButtons, so a control cannot drift between the batch card, the
// generic todo row and the code row. There is no "commit time" control here —
// anything about time is a time note now.
//
// Every control names the exact backend call it fires behind an ⓘ (UI = code).

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import Info from "./info";
import {
  reserveSessionTab,
  type ReservedTab,
} from "@/app/lib/use-open-todo-session";
import type { LiveRulingContext } from "@/app/lib/dts-session-prompt";
import {
  errMessage,
  IMPORTANCE_LEVELS,
  VERDICTS,
  type RulingVerdict,
  type Todo,
} from "../lib";

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";

export type ImportanceLevel = (typeof IMPORTANCE_LEVELS)[number];

/**
 * The stored importance object, read from the schema itself — dtsTodos and
 * dtsCodeBriefs share the shape, so neither is hand-copied here.
 */
export type ImportanceValue = NonNullable<Todo["importance"]>;

// ── The importance glyph ────────────────────────────────────────────────────
// Three bars of rising height; the number FILLED is the level (1/2/3). Used as
// a button here and as a display-only mark on the batch card, from this one
// definition so the two cannot look different.

const BAR_HEIGHTS = ["40%", "70%", "100%"];

export function ImportanceBars({
  level,
  fillCls,
}: {
  level: ImportanceLevel;
  /** Tailwind background for the filled bars (bg-accent / bg-warning / …). */
  fillCls: string;
}) {
  const filled = IMPORTANCE_LEVELS.indexOf(level) + 1;
  return (
    <span className="inline-flex h-3 w-3.5 items-end gap-px align-middle">
      {BAR_HEIGHTS.map((h, i) => (
        <span
          key={h}
          style={{ height: h }}
          className={`w-1 rounded-[1px] ${i < filled ? fillCls : "bg-border/40"}`}
        />
      ))}
    </span>
  );
}

function importanceTitle(current: ImportanceValue | undefined): string {
  if (!current) return "importance";
  const base = `${current.level} · ${current.setBy}`;
  return current.rationale ? `${base} — ${current.rationale}` : base;
}

function ImportanceSetter({
  current,
  infoLabel,
  disabled,
  onSet,
}: {
  current: ImportanceValue | undefined;
  infoLabel: string;
  disabled: boolean;
  onSet: (level: ImportanceLevel | null) => void;
}) {
  const [hover, setHover] = useState<ImportanceLevel | null>(null);
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={importanceTitle(current)}
    >
      {IMPORTANCE_LEVELS.map((lvl) => {
        const isCurrent = current?.level === lvl;
        const fill = isCurrent
          ? "bg-accent"
          : hover === lvl
            ? "bg-text-faint"
            : "bg-border";
        return (
          <button
            key={lvl}
            type="button"
            disabled={disabled}
            // Clicking the CURRENT level clears it (level: null).
            onClick={() => onSet(isCurrent ? null : lvl)}
            onMouseEnter={() => setHover(lvl)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(lvl)}
            onBlur={() => setHover(null)}
            aria-label={isCurrent ? `clear importance ${lvl}` : lvl}
            className="px-0.5 py-1 disabled:opacity-50 disabled:pointer-events-none"
          >
            <ImportanceBars level={lvl} fillCls={fill} />
          </button>
        );
      })}
      <Info label={infoLabel} />
    </span>
  );
}

// ── The row ─────────────────────────────────────────────────────────────────

type Mode = RulingVerdict | "done" | "set-archived";

const PLACEHOLDER: Record<Mode, string> = {
  approve: "note (optional)",
  revise: "sentence (required)",
  session: "note (optional)",
  archive: "unarchive when (optional)",
  done: "note (optional)",
  "set-archived": "propose back when (optional)",
};

const INFO: Record<Mode, string> = {
  approve: 'dtsRulings.recordRuling({verdict:"approve", sentence})',
  revise: 'dtsRulings.recordRuling({verdict:"revise", sentence})',
  session: 'dtsRulings.recordRuling({verdict:"session", sentence})',
  archive: 'dtsRulings.recordRuling({verdict:"archive", sentence})',
  done: 'dts.setStatus({status:"done", note})',
  "set-archived": 'dts.setStatus({status:"archived", unarchiveCondition})',
};

export type OptionsRowProps = {
  /** Life todo or batch row (a batch IS a life todo). Omit for code subjects. */
  todo?: Todo;
  /** Code subject; importance for code lives on its brief. */
  code?: { repo: string; externalId: string; importance?: ImportanceValue };
  /** Show the four verdict chips. */
  rulable: boolean;
  /**
   * Runs AFTER the session verdict is recorded, with the tab reserved in the
   * click and the just-recorded ruling (so its sentence reaches the session
   * prompt instead of Tom repeating himself).
   */
  afterSession?: (tab: ReservedTab, ruling: LiveRulingContext) => void;
  /**
   * Code subjects only: importance is stored on the brief, so a mirror row
   * with no brief has nowhere to put it (dtsCode.setCodeImportance rejects).
   * Defaults to shown.
   */
  showImportance?: boolean;
};

export default function OptionsRow({
  todo,
  code,
  rulable,
  afterSession,
  showImportance = true,
}: OptionsRowProps) {
  const recordRuling = useMutation(api.dtsRulings.recordRuling);
  const setStatus = useMutation(api.dts.setStatus);
  const setImportance = useMutation(api.dts.setImportance);
  const setCodeImportance = useMutation(api.dtsCode.setCodeImportance);

  const [mode, setMode] = useState<Mode | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** `clear` false keeps an open note draft alive (importance is a side click). */
  const run = async (fn: () => Promise<unknown>, clear = true) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (clear) {
        setMode(null);
        setNote("");
      }
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const record = (verdict: RulingVerdict, sentence: string) => {
    const args = { verdict, sentence: sentence || undefined };
    return todo
      ? recordRuling({ todoId: todo._id, ...args })
      : recordRuling({
          repo: code!.repo,
          externalId: code!.externalId,
          ...args,
        });
  };

  const confirm = () => {
    // Guarded here too, not only in run(): the session branch reserves a
    // browser tab before run() would bail, and a bailed run would strand it.
    if (!mode || busy) return;
    const text = note.trim();
    if (mode === "revise" && !text) return;

    if (mode === "done" || mode === "set-archived") {
      if (!todo) return;
      void run(() =>
        mode === "done"
          ? setStatus({ id: todo._id, status: "done", note: text || undefined })
          : setStatus({
              id: todo._id,
              status: "archived",
              unarchiveCondition: text || undefined,
            }),
      );
      return;
    }

    if (mode === "session") {
      // Reserved HERE, synchronously inside the click/submit, before the
      // mutation — browsers only honour window.open in the gesture stack.
      // Nothing opens a session for a code subject, so nothing is reserved.
      const tab = afterSession ? reserveSessionTab() : null;
      void run(async () => {
        try {
          await record("session", text);
        } catch (e) {
          tab?.close();
          throw e;
        }
        if (tab) {
          afterSession?.(tab, {
            verdict: "session",
            sentence: text || undefined,
          });
        }
      });
      return;
    }

    void run(() => record(mode, text));
  };

  const applyImportance = (level: ImportanceLevel | null) =>
    void run(
      () =>
        todo
          ? setImportance({ id: todo._id, level })
          : setCodeImportance({
              repo: code!.repo,
              externalId: code!.externalId,
              level,
            }),
      false,
    );

  if (!todo && !code) return null;

  const chips: { mode: Mode; label: string }[] = [];
  if (rulable) for (const v of VERDICTS) chips.push({ mode: v, label: v });
  // Done is available wherever the row is not already done — a waiting todo is
  // finished the same way an active one is.
  if (todo && todo.status !== "done") {
    chips.push({ mode: "done", label: "done" });
  }
  // A rulable subject already has the archive VERDICT (which archives the row
  // itself) — never both.
  if (todo && !rulable && todo.status !== "archived") {
    chips.push({ mode: "set-archived", label: "archive" });
  }

  const importance = todo ? todo.importance : code?.importance;
  const importanceInfo = todo
    ? 'dts.setImportance({level: "low"|"medium"|"high"|null})'
    : 'dtsCode.setCodeImportance({repo, externalId, level: "low"|"medium"|"high"|null})';

  if (chips.length === 0 && !showImportance) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {chips.map((c) => (
          <button
            key={c.mode}
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setNote("");
              setMode((m) => (m === c.mode ? null : c.mode));
            }}
            className={`${btnCls} ${mode === c.mode ? "border-accent/60 text-text" : ""}`}
          >
            {c.label}
          </button>
        ))}

        {showImportance && (
          <>
            {chips.length > 0 && (
              <span className="text-xs text-text-faint" aria-hidden>
                ·
              </span>
            )}
            <ImportanceSetter
              current={importance}
              infoLabel={importanceInfo}
              disabled={busy}
              onSet={applyImportance}
            />
          </>
        )}
      </div>

      {mode && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={PLACEHOLDER[mode]}
            autoFocus
            className={`${inputCls} flex-1 min-w-56 max-w-md`}
          />
          <button
            type="submit"
            disabled={busy || (mode === "revise" && !note.trim())}
            className={btnCls}
          >
            {mode === "set-archived" ? "archive" : mode}
          </button>
          <Info label={INFO[mode]} />
        </form>
      )}

      {error && <div className="text-xs text-error">{error}</div>}
    </div>
  );
}
