"use client";

import Link from "next/link";
import TomLogo from "./tom-logo";
import TomSymbol, { TOM_SYMBOL_VB } from "./tom-symbol";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useAuth, getUsername } from "../lib/auth";
import { useHeroMode } from "../lib/hero-mode";
import LoginModal from "./login-modal";
import ProfileModal from "./profile-modal";
import { rankQuests } from "./quest-routes";

/* Hero-state target positions (relative to docked positions, applied via transform).
   Measurements are of the *docked* row; we translate from docked → hero using
   the delta, then scale. Same trick as before, now state-driven (heroMode)
   instead of scroll-driven. */
const HERO_LOGO_CY = 172;
const HERO_INPUT_CY = 328;
const HERO_HINT_CY = 250;
const HERO_LOGO_SCALE = 2.6;
const HERO_INPUT_SCALE = 1.25;
const DOCK_TRANSITION = "420ms cubic-bezier(0.22, 0.61, 0.36, 1)";

/* Responsive cut-points for the docked layout. */
const COMPACT_PX = 480;  // below this: logo collapses to tom.quest symbol only
const TINY_PX    = 360;  // below this: "show pages" label drops to bare ▼

type NavOffsets = { left?: number; right?: number };

type HeroOffset = {
  logo:  { x: number; y: number };
  input: { x: number; y: number; width: number };
  ready: boolean;
};

const EMPTY_OFFSET: HeroOffset = {
  logo:  { x: 0, y: 0 },
  input: { x: 0, y: 0, width: 448 },
  ready: false,
};

/* Viewport width hook — coarse, just needs to flip at the breakpoints. */
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
  const pathname = usePathname();
  const router = useRouter();
  const isHome = pathname === "/";
  const { user, isTom } = useAuth();
  const { mode: heroMode, startGame, exitToHome } = useHeroMode();
  const displayName = getUsername(user);
  const vw = useViewportWidth();
  const compact = vw < COMPACT_PX;
  const tiny    = vw < TINY_PX;

  const [loginOpen, setLoginOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  // Terminal state
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(heroMode === "hero");
  const inputRef = useRef<HTMLInputElement>(null);
  const pillRef  = useRef<HTMLDivElement>(null);

  // dock 0 = hero, 1 = docked. State-driven via heroMode; CSS transitions handle motion.
  const targetDock = heroMode === "hero" ? 0 : 1;
  const [dock, setDock] = useState(targetDock);
  useEffect(() => { setDock(targetDock); }, [targetDock]);

  // Dropdown open state follows mode, but user can toggle while docked.
  useEffect(() => {
    setOpen(heroMode === "hero");
  }, [heroMode]);

  // Measure docked slot positions so we can compute the hero transforms.
  const logoSlotRef  = useRef<HTMLDivElement>(null);
  const inputSlotRef = useRef<HTMLDivElement>(null);
  const [heroOffset, setHeroOffset] = useState<HeroOffset>(EMPTY_OFFSET);

  useLayoutEffect(() => {
    if (!isHome) {
      setHeroOffset(EMPTY_OFFSET);
      return;
    }
    const measure = () => {
      const logoEl  = logoSlotRef.current;
      const inputEl = inputSlotRef.current;
      if (!logoEl || !inputEl) return;
      const l = logoEl.getBoundingClientRect();
      const i = inputEl.getBoundingClientRect();
      const vwNow = window.innerWidth;
      setHeroOffset({
        logo: {
          x: vwNow / 2 - (l.left + l.width / 2),
          y: HERO_LOGO_CY - (l.top + l.height / 2),
        },
        input: {
          x: vwNow / 2 - (i.left + i.width / 2),
          y: HERO_INPUT_CY - (i.top + i.height / 2),
          width: i.width,
        },
        ready: true,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [isHome, compact, tiny]);

  const ud = 1 - dock;
  const showHeroTransforms = isHome && heroOffset.ready;

  const logoStyle: CSSProperties = showHeroTransforms
    ? {
        transform: `translate(${heroOffset.logo.x * ud}px, ${heroOffset.logo.y * ud}px) scale(${1 + (HERO_LOGO_SCALE - 1) * ud})`,
        transformOrigin: "center",
        transition: `transform ${DOCK_TRANSITION}`,
        willChange: "transform",
      }
    : { transition: `transform ${DOCK_TRANSITION}` };

  const inputStyle: CSSProperties = showHeroTransforms
    ? {
        transform: `translate(${heroOffset.input.x * ud}px, ${heroOffset.input.y * ud}px) scale(${1 + (HERO_INPUT_SCALE - 1) * ud})`,
        transformOrigin: "center",
        transition: `transform ${DOCK_TRANSITION}`,
        willChange: "transform",
      }
    : { transition: `transform ${DOCK_TRANSITION}` };

  // Terminal routing + keyboard
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
        if (heroMode !== "hero") setOpen(false);
        inputRef.current?.blur();
      }
    },
    [ranked.length, suggestion, submit, heroMode],
  );

  // Dropdown is absolutely positioned relative to the pill. Uses pill's live bounds
  // so it tracks width + position across dock transitions and responsive changes.
  // `ready` gates the first paint — without it the dropdown briefly renders at stale
  // coordinates and then jumps, which showed up as a fly-in from a prior layout.
  const [pillBox, setPillBox] = useState<{ left: number; top: number; width: number; ready: boolean }>({
    left: 0, top: 0, width: 0, ready: false,
  });

  // Sync measure before first paint when opening so the dropdown lands in the right place.
  useLayoutEffect(() => {
    if (!open) {
      setPillBox((b) => ({ ...b, ready: false }));
      return;
    }
    const el = pillRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPillBox({ left: r.left, top: r.bottom, width: r.width, ready: true });
  }, [open, dock, compact, tiny]);

  // Track the pill across the dock transition via rAF state updates (no CSS transition —
  // driving position purely from state avoids the CSS animation racing stale values).
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const measure = () => {
      const el = pillRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPillBox({ left: r.left, top: r.bottom, width: r.width, ready: true });
    };
    const tick = () => {
      measure();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const tmo = window.setTimeout(() => {
      cancelAnimationFrame(raf);
      measure();
    }, 650);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(tmo);
      window.removeEventListener("resize", measure);
    };
  }, [open, dock, compact, tiny]);

  // Close dropdown when clicking outside (docked only; hero stays open).
  useEffect(() => {
    if (!open || heroMode === "hero") return;
    const onDocDown = (e: MouseEvent) => {
      const el = pillRef.current;
      const target = e.target as Node;
      if (el && (el.contains(target))) return;
      // Include the dropdown surface: walk up and check for the data-attr.
      let n: HTMLElement | null = target as HTMLElement;
      while (n) {
        if (n.dataset?.navDropdown === "1") return;
        n = n.parentElement;
      }
      setOpen(false);
    };
    window.addEventListener("mousedown", onDocDown);
    return () => window.removeEventListener("mousedown", onDocDown);
  }, [open, heroMode]);

  /* Logo click: hero → startGame; docked+home → exitToHome (reset game);
     docked+other → let Link navigate to /. */
  const onLogoClick = (e: React.MouseEvent) => {
    if (isHome && heroMode === "hero") {
      e.preventDefault();
      startGame();
      return;
    }
    if (isHome && heroMode === "docked") {
      e.preventDefault();
      exitToHome();
      return;
    }
  };

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
        {/* Docked background — appears as dock progresses */}
        <div
          className="absolute inset-x-0 top-0 h-16 border-b"
          style={{
            backgroundColor: `rgba(10, 14, 23, ${0.85 * dock})`,
            borderBottomColor: dock > 0 ? `rgba(30, 41, 59, ${dock})` : "transparent",
            backdropFilter: dock > 0 ? "blur(6px)" : "none",
            WebkitBackdropFilter: dock > 0 ? "blur(6px)" : "none",
            transition: `background-color ${DOCK_TRANSITION}, border-bottom-color ${DOCK_TRANSITION}`,
          }}
          aria-hidden
        />

        {/* Docked row — hosts logo (left), nav-term (center), auth (right).
            Each slot has its own transform that springs to the hero target when dock=0. */}
        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          {/* Logo slot */}
          <div ref={logoSlotRef} style={logoStyle} className="shrink-0">
            <Link
              href="/"
              onClick={onLogoClick}
              aria-label={heroMode === "hero" ? "Play game" : "tom.Quest home"}
              className="block hover:opacity-85 transition-opacity cursor-pointer"
            >
              {dockedLogo}
            </Link>
          </div>

          {/* Nav-term pill + auth pill — grouped so the whole row can translate as a unit */}
          <div ref={inputSlotRef} className="flex-1 min-w-0 flex items-center justify-center gap-2" style={inputStyle}>
            {/* Pill: input + show-pages button. `h-10` matches the auth pill exactly. */}
            <div
              ref={pillRef}
              className={`font-mono flex items-center gap-2 bg-surface border border-border pl-3 pr-1 h-10 flex-1 max-w-md min-w-0 focus-within:border-accent/80 transition-[border-color,border-radius] duration-150 ${open ? "rounded-t-lg rounded-b-none border-b-border/30" : "rounded-lg"}`}
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
                  placeholder={heroMode === "hero" ? "pick a destination" : "navigate\u2026"}
                  className="relative z-10 w-full bg-transparent outline-none text-text caret-accent placeholder:text-text-faint text-sm"
                />
                {suggestion && query && (
                  <div className="absolute inset-0 flex items-center pointer-events-none text-sm">
                    <span className="invisible">{query}</span>
                    <span className="text-text-faint">{suggestion.slice(query.length)}</span>
                  </div>
                )}
              </div>
              {/* Kept mounted when dropdown is open so the pill width doesn't shift;
                  `invisible` hides it from view while preserving its box. */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen(true); inputRef.current?.focus(); }}
                className={`flex items-center gap-1.5 text-accent hover:text-accent/80 text-xs font-mono rounded-md px-2.5 py-1 transition-colors shrink-0 ${showPagesVisible ? "" : "invisible pointer-events-none"}`}
                aria-label="Show pages"
                aria-hidden={!showPagesVisible}
                tabIndex={showPagesVisible ? 0 : -1}
              >
                {showPagesLabel && <span>{showPagesLabel}</span>}
                <span aria-hidden className="text-sm leading-none">▼</span>
              </button>
            </div>

            {/* Auth pill — paired, flush-adjacent to the nav-term pill. Height matches. */}
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
        </div>

        {/* Hero hint — only visible on home+hero. Fades with dock. */}
        {isHome && (
          <div
            className="pointer-events-none fixed left-1/2 -translate-x-1/2 font-mono text-[0.72rem] tracking-[0.28em] uppercase text-accent/80"
            style={{
              top: HERO_HINT_CY,
              opacity: ud,
              transition: `opacity ${DOCK_TRANSITION}, top ${DOCK_TRANSITION}`,
            }}
            aria-hidden={heroMode !== "hero"}
          >
            press space or click the tom.Quest logo to play
          </div>
        )}

        {/* Dropdown — flush below the pill, same width, shared border.
            Position is driven by rAF-measured state; no CSS transition to avoid
            animating from stale coords to fresh ones. */}
        {open && pillBox.ready && (
          <div
            data-nav-dropdown="1"
            className="fixed z-40"
            style={{
              left:  pillBox.left,
              top:   pillBox.top,
              width: pillBox.width,
              maxWidth: "calc(100vw - 2rem)",
            }}
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
