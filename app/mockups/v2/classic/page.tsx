"use client";

import { useDockProgress } from "../use-dock";
import { useTerminal } from "../use-terminal";

export default function ClassicMockup() {
  const t = useTerminal(true);
  const dock = useDockProgress(300);

  // Interpolated transforms: logo shrinks + slides left, terminal slides up.
  const logoScale = 1 - dock * 0.7;
  const logoX = -dock * 420;
  const heroY = -dock * 180;

  return (
    <div className="min-h-[220vh]">
      {/* Docked top bar (fades in as you scroll) */}
      <DockedBar dock={dock} query={t.query} />

      {/* Hero */}
      <div
        className="relative flex flex-col items-center pt-20 pb-32 px-6"
        style={{ transform: `translateY(${heroY}px)`, willChange: "transform" }}
      >
        {/* Logo */}
        <div
          className="select-none"
          style={{
            transform: `translateX(${logoX}px) scale(${logoScale})`,
            transformOrigin: "center top",
            willChange: "transform",
          }}
        >
          <h1 className="font-display font-bold text-7xl md:text-8xl text-center">
            <span className="text-text">tom.</span>
            <span className="text-accent">Quest</span>
          </h1>
        </div>

        {/* Terminal */}
        <div className="w-full max-w-2xl mt-16 font-mono" style={{ opacity: 1 - dock }}>
          <div className="flex items-center gap-3 bg-surface border border-border rounded-lg px-4 py-3 focus-within:border-accent transition-colors">
            <span className="text-accent">{">"}</span>
            <div className="relative flex-1">
              <input
                ref={t.inputRef}
                value={t.query}
                onChange={(e) => t.setQuery(e.target.value)}
                onKeyDown={t.onKeyDown}
                onFocus={() => t.setOpen(true)}
                spellCheck={false}
                autoComplete="off"
                placeholder="where to?"
                className="relative z-10 w-full bg-transparent outline-none text-text caret-accent placeholder:text-text-faint"
              />
              {t.suggestion && t.query && (
                <div className="absolute inset-0 flex items-center pointer-events-none">
                  <span className="invisible">{t.query}</span>
                  <span className="text-text-faint">{t.suggestion.slice(t.query.length)}</span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => t.setOpen((o) => !o)}
              className="text-text-faint hover:text-text-muted text-xs px-1"
              aria-label={t.open ? "collapse quests" : "expand quests"}
            >
              {t.open ? "▲" : "▼"}
            </button>
          </div>

          {/* Helper text */}
          <div className="mt-2 text-xs text-text-faint px-1 flex gap-3">
            <span>type a destination</span>
            <span className="text-text-muted">·</span>
            <span><kbd className="text-text-muted">↵</kbd> go</span>
            <span className="text-text-muted">·</span>
            <span><kbd className="text-text-muted">⇥</kbd> accept</span>
            <span className="text-text-muted">·</span>
            <span><kbd className="text-text-muted">↑↓</kbd> cycle</span>
          </div>

          {/* Dropdown: list */}
          {t.open && (
            <ul className="mt-4 border border-border rounded-lg bg-surface overflow-hidden">
              {t.ranked.map((r, i) => (
                <li key={r.slug}>
                  <button
                    type="button"
                    onClick={() => t.submit(r.slug)}
                    onMouseEnter={() => t.setCursor(i)}
                    className={`w-full flex items-baseline gap-3 px-4 py-3 text-left transition-colors ${
                      i === t.cursor ? "bg-surface-alt text-text" : "text-text-muted hover:text-text"
                    }`}
                  >
                    <span className={i === t.cursor ? "text-accent" : "text-text-faint"}>
                      {i === t.cursor ? "▸" : " "}
                    </span>
                    <span className="font-medium">/{r.slug}</span>
                    <span className="text-text-faint text-sm">— {r.blurb}</span>
                  </button>
                </li>
              ))}
              {t.ranked.length === 0 && (
                <li className="px-4 py-3 text-text-faint text-sm">
                  no match for <code className="text-error">{t.query}</code> — hit ↵ to get lost
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      <div className="text-center text-text-faint text-xs pb-40">↓ scroll to see the terminal dock at top ↓</div>
    </div>
  );
}

// Docked top bar shown when scrolled. Stripped-down placeholder — in the real
// build this would host the live input and auth.
function DockedBar({ dock, query }: { dock: number; query: string }) {
  return (
    <div
      className="fixed top-0 inset-x-0 z-40 bg-bg/90 backdrop-blur-md border-b border-border h-14 flex items-center px-4 gap-3 font-mono"
      style={{ opacity: dock, pointerEvents: dock > 0.5 ? "auto" : "none" }}
    >
      <div className="font-display font-bold text-xl">
        <span className="text-text">t.</span><span className="text-accent">Q</span>
      </div>
      <div className="flex-1 flex items-center gap-2 border border-border rounded px-3 py-1.5 bg-surface/60 text-sm">
        <span className="text-accent">{">"}</span>
        <span className="text-text-muted">{query || "navigate…"}</span>
      </div>
      <button className="text-sm px-3 py-1.5 rounded border border-border text-text-muted hover:text-text transition-colors">
        Log in
      </button>
    </div>
  );
}
