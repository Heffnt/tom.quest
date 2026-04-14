"use client";

import { useDockProgress } from "../use-dock";
import { useTerminal } from "../use-terminal";

export default function PreviewMockup() {
  const t = useTerminal(true);
  const dock = useDockProgress(300);

  const logoScale = 1 - dock * 0.7;
  const logoX = -dock * 420;
  const heroY = -dock * 180;

  const active = t.ranked[t.cursor];

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

        <div className="w-full max-w-4xl mt-16" style={{ opacity: 1 - dock }}>
          {/* Input */}
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
                placeholder="search quests"
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
            <kbd className="text-text-muted">↑↓</kbd> browse · <kbd className="text-text-muted">↵</kbd> open · <kbd className="text-text-muted">⇥</kbd> accept
          </div>

          {/* Dropdown: split list + preview */}
          {t.open && t.ranked.length > 0 && (
            <div className="mt-4 border border-border rounded-lg bg-surface overflow-hidden grid grid-cols-[minmax(200px,1fr)_2fr]">
              {/* List */}
              <ul className="border-r border-border max-h-96 overflow-y-auto">
                {t.ranked.map((r, i) => (
                  <li key={r.slug}>
                    <button
                      type="button"
                      onClick={() => t.submit(r.slug)}
                      onMouseEnter={() => t.setCursor(i)}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left font-mono text-sm transition-colors ${
                        i === t.cursor ? "bg-surface-alt text-text" : "text-text-muted hover:text-text"
                      }`}
                    >
                      <span className={`text-xl ${i === t.cursor ? "text-accent" : "text-text-faint"}`}>
                        {r.glyph}
                      </span>
                      <span className="flex-1">/{r.slug}</span>
                      {i === t.cursor && <span className="text-accent text-xs">↵</span>}
                    </button>
                  </li>
                ))}
              </ul>

              {/* Preview pane */}
              <div className="p-6 flex flex-col">
                {active ? (
                  <>
                    <div className="flex items-baseline gap-3 mb-4">
                      <span className="text-5xl font-display text-accent">{active.glyph}</span>
                      <div>
                        <div className="font-display text-2xl font-bold">{active.title}</div>
                        <div className="font-mono text-xs text-text-faint">tom.quest/{active.slug}</div>
                      </div>
                    </div>
                    <p className="text-text-muted">{active.blurb}</p>

                    {/* Screenshot placeholder */}
                    <div className="mt-6 flex-1 min-h-[160px] rounded border border-dashed border-border flex items-center justify-center text-text-faint text-xs font-mono">
                      [ preview of /{active.slug} ]
                    </div>

                    <button
                      type="button"
                      onClick={() => t.submit(active.slug)}
                      className="mt-4 self-start text-sm px-4 py-2 rounded border border-accent text-accent hover:bg-accent/10 transition-colors font-mono"
                    >
                      open →
                    </button>
                  </>
                ) : (
                  <div className="text-text-faint text-sm">nothing selected</div>
                )}
              </div>
            </div>
          )}

          {t.open && t.ranked.length === 0 && (
            <div className="mt-4 px-4 py-6 border border-dashed border-border rounded-lg text-center text-text-faint text-sm font-mono">
              no match for <code className="text-error">{t.query}</code> — hit ↵ to get lost
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
