"use client";

// ActionRow — principle 3: at most five actions, each a button that names the
// backend call it fires. The call is shown through the site's ONE info
// mechanism (app/AGENTS.md, ratified 2026-08-29): the ⓘ beside each button is
// app/tts/components/info, the same tap-to-open popover every /tts control
// carries, holding a plain line on what the call does and the call in mono.
// app/tts/components/popover-contract.test.tsx holds this file to that
// contract with the TTS and runs screens. Inside the toolbox root the popover
// is drawn at the toolbox scale (toolbox.css), so nothing on a toolbox page is
// under 13 px.
//
// An action whose call takes a sentence (`ask`) opens a fixed dialog for it,
// so no form ever opens between controls; its confirm button names the same
// call. A refused call's message is shown on a line kept for it, so an error
// appearing moves nothing.

import { useState } from "react";
import { createPortal } from "react-dom";
import Info from "@/app/tts/components/info";
import { errMessage } from "@/app/tts/lib";
import { ACTION_CAP } from "./caps";

type Action = {
  label: string;
  /** The exact backend call, e.g. `ttsRulings.recordRuling({ todoId, verdict: "approve", sentence })`. */
  call: string;
  /** Plain language: what that call does. The popover's first line. */
  effect: string;
  /** Fires the call; `sentence` is what the dialog collected, or "". */
  onClick: (sentence: string) => unknown;
  recommended?: boolean;
  /** The call takes a sentence: pressing opens a dialog asking for it. */
  ask?: { placeholder: string; required?: boolean };
};

export default function ActionRow({ actions }: { actions: readonly Action[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<Action | null>(null);
  const [sentence, setSentence] = useState("");

  const fire = async (action: Action, text: string) => {
    setBusy(true);
    setError(null);
    try {
      await action.onClick(text);
      setAsking(null);
      setSentence("");
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const press = (action: Action) => {
    if (action.ask) {
      setError(null);
      setSentence("");
      setAsking(action);
      return;
    }
    if (!busy) void fire(action, "");
  };

  return (
    <div className="tb-actions-block">
      <div className="tb-actions">
        {actions.slice(0, ACTION_CAP).map((action) => (
          <span key={action.label} className="tb-action">
            <button
              type="button"
              className={`tb-btn${action.recommended ? " is-recommended" : ""}`}
              disabled={busy}
              onClick={() => press(action)}
            >
              {action.label}
            </button>
            <Info call={action.call}>{action.effect}</Info>
          </span>
        ))}
      </div>
      <p className="tb-actions-error" role="status">
        {asking ? "" : error}
      </p>
      {asking &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="tb-root tb-overlay">
            <div className="tb-overlay-shade" onClick={() => setAsking(null)} />
            <div className="tb-dialog" role="dialog" aria-label={asking.label}>
              <h2 className="tb-title">{asking.label}</h2>
              <textarea
                className="tb-input"
                value={sentence}
                placeholder={asking.ask?.placeholder}
                onChange={(e) => setSentence(e.target.value)}
                autoFocus
              />
              <div className="tb-actions">
                <span className="tb-action">
                  <button
                    type="button"
                    className="tb-btn is-recommended"
                    disabled={busy || (asking.ask?.required === true && sentence.trim() === "")}
                    onClick={() => void fire(asking, sentence.trim())}
                  >
                    {asking.label}
                  </button>
                  <Info call={asking.call}>{asking.effect}</Info>
                </span>
                <button type="button" className="tb-btn" onClick={() => setAsking(null)}>
                  cancel
                </button>
              </div>
              <p className="tb-actions-error" role="status">
                {error}
              </p>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
