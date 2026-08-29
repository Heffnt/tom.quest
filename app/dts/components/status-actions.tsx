"use client";

// The controls a life todo carries WHEREVER it is shown — the generic row
// (everything tab) and the batch card render these same two components, so the
// mutations, the validation messages and the draft-clearing cannot drift
// between the two surfaces. A batch IS a life todo, which is why one strip
// serves both.
//
// StatusActions:     Done(+note) · Archive(+unarchiveCondition) · Commit time
// ImportanceButtons: the three-level override + clear
//
// Each control names the exact backend call it fires behind an ⓘ (UI = code).

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import Info from "./info";
import {
  errMessage,
  IMPORTANCE_LEVELS,
  toDatetimeLocal,
  type Todo,
} from "../lib";

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";

export function StatusActions({ todo }: { todo: Todo }) {
  const setStatus = useMutation(api.dts.setStatus);
  const createBlock = useMutation(api.dts.createBlock);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneNoteDraft, setDoneNoteDraft] = useState("");
  const [unarchiveDraft, setUnarchiveDraft] = useState("");
  const [blockStartDraft, setBlockStartDraft] = useState("");
  const [blockEndDraft, setBlockEndDraft] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const commitBlock = () => {
    const start = blockStartDraft ? new Date(blockStartDraft).getTime() : NaN;
    const end = blockEndDraft ? new Date(blockEndDraft).getTime() : NaN;
    if (Number.isNaN(start) || Number.isNaN(end)) {
      setError("pick start and end");
      return;
    }
    if (end <= start) {
      setError("end must be after start");
      return;
    }
    void run(async () => {
      await createBlock({ start, end, todoId: todo._id });
      setBlockStartDraft("");
      setBlockEndDraft("");
    });
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        {todo.status !== "done" && (
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                void run(() =>
                  setStatus({
                    id: todo._id,
                    status: "done",
                    note: doneNoteDraft.trim() || undefined,
                  }),
                )
              }
              disabled={busy}
              className={btnCls}
            >
              Done
            </button>
            <input
              value={doneNoteDraft}
              onChange={(e) => setDoneNoteDraft(e.target.value)}
              placeholder="note (optional)"
              className={`${inputCls} w-40`}
            />
            <Info label='dts.setStatus({status:"done"})' />
          </div>
        )}

        {todo.status !== "archived" && (
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                void run(() =>
                  setStatus({
                    id: todo._id,
                    status: "archived",
                    unarchiveCondition: unarchiveDraft.trim() || undefined,
                  }),
                )
              }
              disabled={busy}
              className={btnCls}
            >
              Archive
            </button>
            <input
              value={unarchiveDraft}
              onChange={(e) => setUnarchiveDraft(e.target.value)}
              placeholder="propose back when (optional)"
              className={`${inputCls} w-52`}
            />
            <Info label='dts.setStatus({status:"archived"})' />
          </div>
        )}

        {/* commit time — end prefills to start + 1 h, cleared on success */}
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            value={blockStartDraft}
            onChange={(e) => {
              const v = e.target.value;
              setBlockStartDraft(v);
              const ms = v ? new Date(v).getTime() : NaN;
              if (!Number.isNaN(ms)) {
                setBlockEndDraft(toDatetimeLocal(ms + 3_600_000));
              }
            }}
            className={inputCls}
          />
          <input
            type="datetime-local"
            value={blockEndDraft}
            onChange={(e) => setBlockEndDraft(e.target.value)}
            className={inputCls}
          />
          <button onClick={commitBlock} disabled={busy} className={btnCls}>
            Commit time
          </button>
          <Info label="dts.createBlock({todoId})" />
        </div>
      </div>

      {error && <div className="text-xs text-error">{error}</div>}
    </div>
  );
}

/**
 * The importance override — three levels, current highlighted; agent writes
 * are ignored server-side once Tom has set one, so setBy is the provenance
 * shown next to an agent rationale.
 */
export function ImportanceButtons({ todo }: { todo: Todo }) {
  const setImportance = useMutation(api.dts.setImportance);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setLevel = async (level: "low" | "medium" | "high" | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setImportance({ id: todo._id, level });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-text-faint">importance</span>
        {IMPORTANCE_LEVELS.map((lvl) => (
          <button
            key={lvl}
            onClick={() => void setLevel(lvl)}
            disabled={busy}
            className={`${btnCls} ${
              todo.importance?.level === lvl ? "border-accent/60 text-text" : ""
            }`}
          >
            {lvl}
          </button>
        ))}
        {todo.importance && (
          <button
            onClick={() => void setLevel(null)}
            disabled={busy}
            className="text-xs text-text-faint hover:text-text-muted"
          >
            clear
          </button>
        )}
        <Info label="dts.setImportance({level})" />
        {todo.importance && (
          <span className="text-xs text-text-faint">
            · {todo.importance.setBy}
          </span>
        )}
      </div>
      {todo.importance?.setBy === "agent" && todo.importance.rationale && (
        <div className="text-xs text-text-faint">
          {todo.importance.rationale}
        </div>
      )}
      {error && <div className="text-xs text-error">{error}</div>}
    </div>
  );
}
