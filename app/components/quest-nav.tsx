"use client";

import Image from "next/image";
import Link from "next/link";
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
import LoginModal from "./login-modal";
import ProfileModal from "./profile-modal";
import { QUESTS, rankQuests } from "./quest-routes";

const SCROLL_THRESHOLD = 280;   // px of scroll to reach fully-docked state
const HERO_LOGO_CY = 180;       // target center-Y for hero logo
const HERO_INPUT_CY = 320;      // target center-Y for hero input
const HERO_LOGO_SCALE = 3;
const HERO_INPUT_SCALE = 1.3;

type NavOffsets = { left?: number; right?: number };

type HeroOffset = {
  logo: { x: number; y: number };
  input: { x: number; y: number; width: number };
  ready: boolean;
};

const EMPTY_OFFSET: HeroOffset = {
  logo: { x: 0, y: 0 },
  input: { x: 0, y: 0, width: 448 },
  ready: false,
};

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
  const displayName = getUsername(user);

  const [loginOpen, setLoginOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  // Terminal state
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(isHome);
  const inputRef = useRef<HTMLInputElement>(null);

  // Scroll-dock: 0 = hero (home only), 1 = fully docked
  const [dock, setDock] = useState(isHome ? 0 : 1);
  useEffect(() => {
    if (!isHome) {
      setDock(1);
      return;
    }
    const update = () => {
      const p = Math.min(1, Math.max(0, window.scrollY / SCROLL_THRESHOLD));
      setDock(p);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [isHome]);

  // Auto-close dropdown when scrolling dock >60% on home
  useEffect(() => {
    if (isHome && dock > 0.6) setOpen(false);
  }, [dock, isHome]);

  // Measurement: compute transform offsets from docked → hero positions.
  // Happens in useLayoutEffect so initial paint has correct transforms.
  const logoSlotRef = useRef<HTMLDivElement>(null);
  const inputSlotRef = useRef<HTMLDivElement>(null);
  const [heroOffset, setHeroOffset] = useState<HeroOffset>(EMPTY_OFFSET);

  useLayoutEffect(() => {
    if (!isHome) {
      setHeroOffset(EMPTY_OFFSET);
      return;
    }
    const measure = () => {
      const logoEl = logoSlotRef.current;
      const inputEl = inputSlotRef.current;
      if (!logoEl || !inputEl) return;
      const l = logoEl.getBoundingClientRect();
      const i = inputEl.getBoundingClientRect();
      const vw = window.innerWidth;
      setHeroOffset({
        logo: {
          x: vw / 2 - (l.left + l.width / 2),
          y: HERO_LOGO_CY - (l.top + l.height / 2),
        },
        input: {
          x: vw / 2 - (i.left + i.width / 2),
          y: HERO_INPUT_CY - (i.top + i.height / 2),
          width: i.width,
        },
        ready: true,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [isHome]);

  const ud = 1 - dock;
  const showHeroTransforms = isHome && heroOffset.ready;

  const logoStyle: CSSProperties = showHeroTransforms
    ? {
        transform: `translate(${heroOffset.logo.x * ud}px, ${heroOffset.logo.y * ud}px) scale(${1 + (HERO_LOGO_SCALE - 1) * ud})`,
        transformOrigin: "center",
        transition: "transform 80ms linear",
        willChange: "transform",
      }
    : { transition: "transform 80ms linear" };

  const inputStyle: CSSProperties = showHeroTransforms
    ? {
        transform: `translate(${heroOffset.input.x * ud}px, ${heroOffset.input.y * ud}px) scale(${1 + (HERO_INPUT_SCALE - 1) * ud})`,
        transformOrigin: "center",
        transition: "transform 80ms linear",
        willChange: "transform",
      }
    : { transition: "transform 80ms linear" };

  // Terminal logic
  const ranked = useMemo(() => rankQuests(query), [query]);
  const suggestion = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !ranked[0]) return "";
    return ranked[0].slug.startsWith(q) && ranked[0].slug !== q ? ranked[0].slug : "";
  }, [query, ranked]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const submit = useCallback(
    (override?: string) => {
      const target = (override ?? ranked[cursor]?.slug ?? query).trim().toLowerCase();
      if (!target) return;
      router.push(`/${encodeURIComponent(target)}`);
      setOpen(false);
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
        setOpen(false);
        inputRef.current?.blur();
      }
    },
    [ranked.length, suggestion, submit],
  );

  // Dropdown position: follows the input's visual position.
  // At dock=1, sits 8px below the 64px nav bar.
  // At dock=0, sits below the hero input.
  const dropdownTop = 64 + 8 + ud * (HERO_INPUT_CY + 28 - 72);
  const dropdownWidth = heroOffset.input.width * (1 + 0.3 * ud);

  return (
    <>
      <nav
        aria-label="Main navigation"
        className={`fixed top-0 z-40 ${animateOffsets ? "transition-[left,right] duration-150 ease-out" : ""}`}
        style={{ left: offsets.left ?? 0, right: offsets.right ?? 0 }}
      >
        {/* Background bar — fades in with dock */}
        <div
          className="absolute inset-x-0 top-0 h-16 border-b transition-colors duration-150"
          style={{
            backgroundColor: `rgba(10, 14, 23, ${0.85 * dock})`,
            borderBottomColor: dock > 0 ? `rgba(30, 41, 59, ${dock})` : "transparent",
            backdropFilter: dock > 0 ? "blur(6px)" : "none",
            WebkitBackdropFilter: dock > 0 ? "blur(6px)" : "none",
          }}
          aria-hidden
        />

        {/* Docked layout — hosts logo, input, auth. Flex layout never changes. */}
        <div className="relative max-w-5xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          {/* Logo slot */}
          <div ref={logoSlotRef} style={logoStyle} className="shrink-0">
            <Link href="/" className="block hover:opacity-80 transition-opacity">
              <Image
                src="/images/logo-white-transparent.svg"
                alt="tom.quest"
                width={120}
                height={30}
                priority
              />
            </Link>
          </div>

          {/* Terminal input slot */}
          <div ref={inputSlotRef} className="flex-1 max-w-md mx-auto" style={inputStyle}>
            <div
              className="font-mono flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-1.5 focus-within:border-accent transition-colors"
              onClick={() => inputRef.current?.focus()}
            >
              <span className="text-accent text-sm select-none">{">"}</span>
              <div className="relative flex-1 min-w-0">
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  onFocus={() => setOpen(true)}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={isHome && dock < 0.4 ? "type a destination, or pick below" : "navigate…"}
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
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen((o) => !o);
                }}
                className="text-text-faint hover:text-text-muted text-xs px-1 shrink-0"
                aria-label={open ? "collapse quests" : "expand quests"}
              >
                {open ? "▲" : "▼"}
              </button>
            </div>
          </div>

          {/* Auth slot — no transforms, stays put */}
          <div className="shrink-0">
            {user ? (
              <button
                type="button"
                onClick={() => setProfileOpen(true)}
                className={`text-sm px-3 py-1.5 rounded-lg border transition-colors duration-150 hover:text-text hover:border-text-muted ${
                  isTom ? "border-accent text-accent" : "border-border text-text-muted"
                }`}
              >
                {displayName}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setLoginOpen(true)}
                className="text-sm px-3 py-1.5 rounded-lg border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors duration-150"
              >
                Log in
              </button>
            )}
          </div>
        </div>

        {/* Dropdown — fixed overlay positioned relative to dock progress */}
        {open && (
          <div
            className="absolute left-1/2 -translate-x-1/2 z-40"
            style={{
              top: `${dropdownTop}px`,
              width: `${dropdownWidth}px`,
              maxWidth: "calc(100vw - 2rem)",
              transition: "top 80ms linear, width 80ms linear",
            }}
          >
            <div className="border border-border rounded-lg bg-surface overflow-hidden shadow-xl">
              {/* Helper text — only visible in hero mode */}
              {isHome && dock < 0.4 && (
                <div className="px-4 py-2 text-xs text-text-faint font-mono border-b border-border/50 bg-surface-alt/30 flex flex-wrap gap-x-3 gap-y-1">
                  <span>type to navigate</span>
                  <span className="text-text-muted">·</span>
                  <span><kbd className="text-text-muted">↵</kbd> go</span>
                  <span className="text-text-muted">·</span>
                  <span><kbd className="text-text-muted">⇥</kbd> accept</span>
                  <span className="text-text-muted">·</span>
                  <span><kbd className="text-text-muted">↑↓</kbd> cycle</span>
                </div>
              )}
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
                      <span className="text-text-faint text-xs truncate">— {r.blurb}</span>
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
