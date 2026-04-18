"use client";

import Link from "next/link";
import TomLogo from "./tom-logo";
import TomSymbol, { TOM_SYMBOL_VB } from "./tom-symbol";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth, getUsername } from "../lib/auth";
import LoginModal from "./login-modal";
import ProfileModal from "./profile-modal";
import { rankQuests } from "./quest-routes";

/* Responsive cut-points. */
const COMPACT_PX = 480;  // below: logo collapses to bare tom symbol
const TINY_PX    = 360;  // below: "show pages" label drops to just ▼

type NavOffsets = { left?: number; right?: number };

function useViewportWidth(): number {
  const [w, setW] = useState<number>(() =>
    typeof window === "undefined" ? 1024 : window.innerWidth,
  );
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

export default function QuestNav({
  offsets = { left: 0, right: 0 },
  animateOffsets = true,
}: {
  offsets?: NavOffsets;
  animateOffsets?: boolean;
}) {
  const router = useRouter();
  const { user, isTom } = useAuth();
  const displayName = getUsername(user);
  const vw = useViewportWidth();
  const compact = vw < COMPACT_PX;
  const tiny    = vw < TINY_PX;

  const [loginOpen, setLoginOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pillRef  = useRef<HTMLDivElement>(null);

  const ranked = useMemo(() => rankQuests(query), [query]);
  const suggestion = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !ranked[0]) return "";
    return ranked[0].slug.startsWith(q) && ranked[0].slug !== q ? ranked[0].slug : "";
  }, [query, ranked]);

  useEffect(() => { setCursor(0); }, [query]);

  const submit = useCallback(
    (override?: string) => {
      const target = (override ?? ranked[cursor]?.slug ?? query).trim().toLowerCase();
      if (!target) return;
      router.push(`/${encodeURIComponent(target)}`);
      setQuery("");
      setOpen(false);
    },
    [ranked, cursor, query, router],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
        setCursor((c) => Math.min(ranked.length - 1, c + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (suggestion) setQuery(suggestion);
      } else if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        inputRef.current?.blur();
      }
    },
    [ranked.length, suggestion, submit],
  );

  /* Dropdown is absolutely positioned below the pill. Measure on open +
     resize — the pill doesn't move in this simplified bar so no rAF tracker. */
  const [pillBox, setPillBox] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPillBox(null); return; }
    const measure = () => {
      const el = pillRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPillBox({ left: r.left, top: r.bottom, width: r.width });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, compact, tiny]);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const el = pillRef.current;
      const target = e.target as Node;
      if (el && el.contains(target)) return;
      let n: HTMLElement | null = target as HTMLElement;
      while (n) {
        if (n.dataset?.navDropdown === "1") return;
        n = n.parentElement;
      }
      setOpen(false);
    };
    window.addEventListener("mousedown", onDocDown);
    return () => window.removeEventListener("mousedown", onDocDown);
  }, [open]);

  const dockedLogo = compact ? (
    <svg
      viewBox={`0 0 ${TOM_SYMBOL_VB.w} ${TOM_SYMBOL_VB.h}`}
      width={32}
      height={32 * (TOM_SYMBOL_VB.h / TOM_SYMBOL_VB.w)}
      style={{ color: "var(--color-accent)", display: "block", overflow: "visible" }}
    >
      <TomSymbol />
    </svg>
  ) : (
    <TomLogo fontSize={compact ? 22 : 28} variant="plain" />
  );

  const showPagesLabel = tiny ? null : "show pages";
  const showPagesVisible = !open;

  return (
    <>
      <nav
        aria-label="Main navigation"
        className={`fixed top-0 z-40 ${animateOffsets ? "transition-[left,right] duration-150 ease-out" : ""}`}
        style={{ left: offsets.left ?? 0, right: offsets.right ?? 0 }}
      >
        <div className="absolute inset-x-0 top-0 h-16 border-b border-border bg-[rgba(10,14,23,0.85)] backdrop-blur-md" aria-hidden />

        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-3">
          <div className="shrink-0">
            <Link
              href="/"
              aria-label="tom.Quest home"
              className="block hover:opacity-85 transition-opacity cursor-pointer"
            >
              {dockedLogo}
            </Link>
          </div>

          <div
            ref={pillRef}
            className={`font-mono flex items-center gap-2 bg-surface border border-border pl-3 pr-1 h-10 flex-1 min-w-0 max-w-md focus-within:border-accent/80 transition-[border-color,border-radius] duration-150 ${open ? "rounded-t-lg rounded-b-none border-b-border/30" : "rounded-lg"}`}
            onClick={() => inputRef.current?.focus()}
          >
            <span className="text-accent text-sm select-none leading-none">&gt;</span>
            <div className="relative flex-1 min-w-0">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                onFocus={() => setOpen(true)}
                spellCheck={false}
                autoComplete="off"
                placeholder="navigate…"
                className="relative z-10 w-full bg-transparent outline-none text-text caret-accent placeholder:text-text-faint text-sm"
              />
              {suggestion && query && (
                <div className="absolute inset-0 flex items-center pointer-events-none text-sm">
                  <span className="invisible">{query}</span>
                  <span className="text-text-faint">{suggestion.slice(query.length)}</span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setOpen(true); inputRef.current?.focus(); }}
              className={`flex items-center gap-1.5 text-accent hover:text-accent/80 hover:bg-accent/10 text-xs font-mono border border-accent/60 rounded-md px-2.5 py-1 transition-colors shrink-0 ${showPagesVisible ? "" : "invisible pointer-events-none"}`}
              aria-label="Show pages"
              aria-hidden={!showPagesVisible}
              tabIndex={showPagesVisible ? 0 : -1}
            >
              {showPagesLabel && <span>{showPagesLabel}</span>}
              <span aria-hidden className="text-sm leading-none">▼</span>
            </button>
          </div>

          <div className="shrink-0">
            {user ? (
              <button
                type="button"
                onClick={() => setProfileOpen(true)}
                className={`text-sm px-3 h-10 rounded-lg border transition-colors duration-150 hover:text-text hover:border-text-muted whitespace-nowrap ${
                  isTom ? "border-accent text-accent" : "border-border text-text-muted"
                }`}
              >
                {displayName}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setLoginOpen(true)}
                className="text-sm px-3 h-10 rounded-lg border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors duration-150 whitespace-nowrap"
              >
                Log in
              </button>
            )}
          </div>
        </div>

        {open && pillBox && (
          <div
            data-nav-dropdown="1"
            className="fixed z-40"
            style={{ left: pillBox.left, top: pillBox.top, width: pillBox.width, maxWidth: "calc(100vw - 2rem)" }}
          >
            <div className="border border-border border-t-0 rounded-b-lg bg-surface overflow-hidden shadow-xl">
              <ul>
                {ranked.map((r, i) => (
                  <li key={r.slug}>
                    <button
                      type="button"
                      onClick={() => submit(r.slug)}
                      onMouseEnter={() => setCursor(i)}
                      className={`w-full flex items-baseline gap-3 px-4 py-2.5 text-left font-mono text-sm transition-colors ${
                        i === cursor ? "bg-surface-alt text-text" : "text-text-muted hover:text-text"
                      }`}
                    >
                      <span className={i === cursor ? "text-accent" : "text-text-faint"}>
                        {i === cursor ? "▸" : " "}
                      </span>
                      <span>/{r.slug}</span>
                      <span className="text-text-faint text-xs truncate hidden sm:inline">— {r.blurb}</span>
                    </button>
                  </li>
                ))}
                {ranked.length === 0 && (
                  <li className="px-4 py-3 text-text-faint text-sm font-mono">
                    no match — hit ↵ to see what&apos;s there
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
      </nav>

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
      <ProfileModal isOpen={profileOpen} onClose={() => setProfileOpen(false)} displayName={displayName} />
    </>
  );
}
