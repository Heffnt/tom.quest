"use client";

import { useTransformer } from "../state";

// Prompt input + the token ribbon. The ribbon is the z-axis scrubber: click a
// token to view the model from that position's perspective; tokens after the
// selection are "the future" and render ghosted.
export default function PromptBar() {
  const { prompt, setPrompt, run, stop, generating, trace, selected, select } = useTransformer();

  return (
    <div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
          placeholder="Prompt…"
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent/60"
        />
        {generating ? (
          <button
            type="button"
            onClick={stop}
            className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text-muted hover:border-error/60 hover:text-error"
          >
            stop
          </button>
        ) : (
          <button
            type="submit"
            className="rounded border border-accent/50 bg-accent-dim px-3 py-1.5 text-sm text-accent hover:border-accent"
          >
            run
          </button>
        )}
      </form>

      {trace && (
        <div className="mt-2 flex flex-wrap items-center gap-1" aria-label="token ribbon (z scrubber)">
          {trace.tokens.map((tok, i) => {
            const isSel = i === selected;
            const isFuture = i > selected;
            const isGen = i >= trace.nPrompt;
            return (
              <button
                key={i}
                onClick={() => select(i)}
                title={`position ${i}${isGen ? " · generated" : ""}`}
                className={[
                  "rounded border px-1 py-0.5 font-mono text-[11px] leading-none transition-opacity",
                  isSel
                    ? "border-accent bg-accent-dim text-text"
                    : isGen
                      ? "border-accent/30 text-accent/90 hover:border-accent/60"
                      : "border-border text-text-muted hover:border-text-faint",
                  isFuture ? "opacity-35" : "",
                ].join(" ")}
              >
                {tok.replaceAll(" ", " ")}
              </button>
            );
          })}
          {generating && <span className="ml-1 animate-pulse text-[11px] text-text-faint">generating…</span>}
        </div>
      )}
    </div>
  );
}
