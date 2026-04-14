"use client";

import { useDockProgress } from "../use-dock";
import { useTerminal } from "../use-terminal";

export default function GridMockup() {
  const t = useTerminal(true);
  const dock = useDockProgress(300);

  const logoScale = 1 - dock * 0.7;
  const logoX = -dock * 420;
  const heroY = -dock * 180;

  return (
    <div className="min-h-[220vh]">
      <DockedBar dock={dock} query={t.query} />

      <div
        className="relative flex flex-col items-center pt-20 pb-32 px-6"
        style={{ transform: `translateY(${heroY}px)`, willChange: "transform" }}
      >
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

        <div className="w-full max-w-3xl mt-16" style={{ opacity: 1 - dock }}>
          {/* Terminal row */}
          <div className="font-mono flex items-center gap-3 bg-surface border border-border rounded-lg px-4 py-3 focus-within:border-accent transition-colors">
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
                placeholder="type a quest or pick below"
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
            >
              {t.open ? "▲" : "▼"}
            </button>
          </div>

          <div className="mt-2 text-xs text-text-faint font-mono px-1">
            type · <kbd className="text-text-muted">⇥</kbd> accept · <kbd className="text-text-muted">↵</kbd> go · or click a card
          </div>

          {/* Dropdown: card grid */}
          {t.open && (
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {t.ranked.map((r, i) => {
                const active = i === t.cursor;
                return (
                  <button
                    key={r.slug}
                    type="button"
                    onClick={() => t.submit(r.slug)}
                    onMouseEnter={() => t.setCursor(i)}
                    className={`group text-left bg-surface border rounded-lg p-5 transition-all ${
                      active
                        ? "border-accent shadow-[0_0_30px_rgba(232,160,64,0.15)] -translate-y-0.5"
                        : "border-border hover:border-text-faint"
                    }`}
                  >
                    <div className="flex items-start justify-between mb-4">
                      <span className={`text-4xl font-display ${active ? "text-accent" : "text-text-muted"}`}>
                        {r.glyph}
                      </span>
                      <span className="font-mono text-xs text-text-faint">/{r.slug}</span>
                    </div>
                    <div className="font-display text-lg font-bold text-text">{r.title}</div>
                    <div className="mt-1 text-sm text-text-muted">{r.blurb}</div>
                  </button>
                );
              })}
              {t.ranked.length === 0 && (
                <div className="col-span-full px-4 py-6 border border-dashed border-border rounded-lg text-center text-text-faint text-sm font-mono">
                  no match for <code className="text-error">{t.query}</code> — hit ↵ to get lost
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="text-center text-text-faint text-xs pb-40 font-mono">↓ scroll to dock ↓</div>
    </div>
  );
}

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
