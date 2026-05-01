/**
 * Click-to-edit cell. Displays a value; clicking turns it into a text input
 * pre-selected for typing. Enter commits, Escape cancels, blur commits.
 *
 * The component is value-format agnostic: the caller provides `display`
 * (what to show when not editing) and `parse` (input string -> committed
 * value, or null to reject). When `disabled` is set the cell is plain text
 * with no edit affordance — used for view-only contexts (the parse and
 * link scenes don't allow CPU pokes).
 */
"use client";

import { useEffect, useRef, useState } from "react";

type Props<T> = {
  value: T;
  display: (v: T) => string;
  parse: (input: string) => T | null;
  onCommit: (v: T) => void;
  className?: string;
  disabled?: boolean;
  /** Visual hint that this cell has been manually overridden. */
  overridden?: boolean;
  /** Tooltip shown on hover. */
  title?: string;
};

export default function Editable<T>({
  value, display, parse, onCommit, className = "", disabled, overridden, title,
}: Props<T>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function commit() {
    const next = parse(draft);
    if (next === null) {
      setBad(true);
      return;
    }
    setEditing(false);
    setBad(false);
    onCommit(next);
  }

  function cancel() {
    setEditing(false);
    setBad(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setBad(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") cancel();
        }}
        onBlur={commit}
        className={`${className} bg-white/[0.04] outline outline-1 ${bad ? "outline-error" : "outline-accent"} px-1`}
      />
    );
  }

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        setDraft(display(value));
        setEditing(true);
      }}
      className={`${className} text-left ${
        disabled ? "cursor-default" : "cursor-text hover:bg-white/[0.04]"
      } ${overridden ? "outline outline-1 outline-accent/40" : ""}`}
    >
      {display(value)}
    </button>
  );
}
