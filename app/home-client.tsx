"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TomLogo from "./components/tom-logo";
import LoginModal from "./components/login-modal";
import ProfileModal from "./components/profile-modal";
import { useAuth, getUsername } from "./lib/auth";
import { rankQuests } from "./components/quest-routes";

/* Home = the expanded nav bar. Big logo centered, nav terminal below with the
   pages list always visible, and the auth button fixed top-right. Everything
   that lives in the docked <QuestNav> has a counterpart here — this page is
   the nav bar, rearranged and enlarged. */
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

function logoFontSize(vw: number): number {
  // Responsive logo size; mirrors the docked bar's scale up for hero use.
  if (vw < 420) return 44;
  if (vw < 720) return 64;
  if (vw < 1024) return 84;
  return 104;
}

export default function HomeClient() {
  const router = useRouter();
  const { user, isTom } = useAuth();
  const displayName = getUsername(user);
  const vw = useViewportWidth();
  const fontSize = logoFontSize(vw);

  const [loginOpen, setLoginOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

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
      }
    },
    [ranked.length, suggestion, submit],
  );

  // Focus input on mount so the user can start typing immediately.
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <>
      {/* Auth button — top right, fixed so it stays put as content grows. */}
      <div className="fixed top-4 right-4 z-30">
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

      <div className="min-h-[calc(100vh-2rem)] flex flex-col items-center justify-center px-6 py-12 gap-10">
        <TomLogo fontSize={fontSize} variant="plain" />

        {/* Expanded terminal: input pill + always-visible page list */}
        <div className="w-full max-w-xl">
          <div
            className="font-mono flex items-center gap-2 bg-surface border border-border pl-4 pr-2 h-12 rounded-t-lg rounded-b-none border-b-border/30 focus-within:border-accent/80 transition-colors duration-150"
            onClick={() => inputRef.current?.focus()}
          >
            <span className="text-accent select-none leading-none">&gt;</span>
            <div className="relative flex-1 min-w-0">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                spellCheck={false}
                autoComplete="off"
                placeholder="pick a destination"
                className="relative z-10 w-full bg-transparent outline-none text-text caret-accent placeholder:text-text-faint"
              />
              {suggestion && query && (
                <div className="absolute inset-0 flex items-center pointer-events-none">
                  <span className="invisible">{query}</span>
                  <span className="text-text-faint">{suggestion.slice(query.length)}</span>
                </div>
              )}
            </div>
          </div>

          <div className="border border-t-0 border-border rounded-b-lg bg-surface overflow-hidden">
            <ul>
              {ranked.map((r, i) => (
                <li key={r.slug}>
                  <Link
                    href={`/${r.slug}`}
                    onMouseEnter={() => setCursor(i)}
                    className={`flex items-baseline gap-3 px-4 py-3 font-mono transition-colors ${
                      i === cursor ? "bg-surface-alt text-text" : "text-text-muted hover:text-text"
                    }`}
                  >
                    <span className={i === cursor ? "text-accent" : "text-text-faint"}>
                      {i === cursor ? "▸" : " "}
                    </span>
                    <span>/{r.slug}</span>
                    <span className="text-text-faint text-sm truncate hidden sm:inline">— {r.blurb}</span>
                  </Link>
                </li>
              ))}
              {ranked.length === 0 && (
                <li className="px-4 py-3 text-text-faint font-mono">
                  no match — hit ↵ to see what&apos;s there
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
      <ProfileModal isOpen={profileOpen} onClose={() => setProfileOpen(false)} displayName={displayName} />
    </>
  );
}
