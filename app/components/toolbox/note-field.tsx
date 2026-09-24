"use client";

// NoteField — principle 3: one sentence Tom types about the thing in front of
// him, and the one call it fires. A single line of fixed height, its button
// naming the call through the site's one info mechanism (the ⓘ beside it, as
// on ActionRow), and under it one mono line that names the call at rest and
// holds a refused call's message in the same space, so nothing moves when an
// error appears or clears. The field empties once the call has taken it.

import { useState } from "react";
import Info from "@/app/tts/components/info";
import { errMessage } from "@/app/tts/lib";

export default function NoteField({
  label,
  placeholder,
  call,
  effect,
  onSubmit,
}: {
  /** The button's word, and the field's accessible name. */
  label: string;
  placeholder: string;
  /** The exact backend call, e.g. `tts.createTimeNote({ text, todoId })`. */
  call: string;
  /** Plain language: what that call does. The popover's first line. */
  effect: string;
  /** Fires the call with the trimmed sentence. A rejection is shown. */
  onSubmit: (text: string) => unknown;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setText("");
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tb-note">
      <form
        className="tb-note-row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          className="tb-note-input"
          aria-label={label}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="tb-action">
          <button type="submit" className="tb-btn" disabled={busy || text.trim() === ""}>
            {label}
          </button>
          <Info call={call}>{effect}</Info>
        </span>
      </form>
      <p className={`tb-note-line${error ? " is-error" : ""}`} role="status">
        {error ?? call}
      </p>
    </div>
  );
}
