"use client";

// The site's part of the top rail: the logo in the top-left corner (home), the
// page name with its (i), a one-line state, a compact navigate field ("/"
// focuses it) and the account button in the top-right corner. It replaces
// NavTerm on a frame page and shares its navigate state (use-nav-search.ts).

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { getUsername, useAuth } from "@/app/lib/auth";
import LoginModal from "../login-modal";
import ProfileModal from "../profile-modal";
import TomQuestSymbol from "../tom-quest-symbol";
import { useNavSearch } from "../use-nav-search";
import type { ExplainerId } from "./explainer-registry.generated";
import Info from "./info";

function Navigate() {
  const { query, setQuery, cursor, setCursor, open, setOpen, ranked, suggestion, submit, onKeyDown, inputRef } =
    useNavSearch();
  return (
    <div className="relative hidden w-56 shrink-0 sm:block">
      <div className="flex h-7 items-center gap-2 rounded-control border border-border bg-bg px-2 font-mono focus-within:border-accent/80">
        <span className="select-none text-[12px] text-accent">&gt;</span>
        <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            data-frame-navigate
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            spellCheck={false}
            autoComplete="off"
            placeholder="navigate…"
            aria-label="Navigate to a page"
            className="relative z-10 w-full bg-transparent text-[12px] text-text caret-accent outline-none placeholder:text-text-faint"
          />
          {suggestion && query && (
            <div className="pointer-events-none absolute inset-0 flex items-center text-[12px]">
              <span className="invisible">{query}</span>
              <span className="text-text-faint">{suggestion.slice(query.length)}</span>
            </div>
          )}
        </div>
      </div>
      {open && (
        <ul className="absolute right-0 top-8 w-80 overflow-hidden rounded-panel border border-border bg-surface shadow-xl">
          {ranked.map((r, i) => (
            <li key={r.slug}>
              <button
                type="button"
                // mousedown, not click: the input's blur closes the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  submit(r.slug);
                }}
                onMouseEnter={() => setCursor(i)}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left font-mono text-[12px] ${
                  i === cursor ? "bg-surface-alt text-text" : "text-text-muted hover:text-text"
                }`}
              >
                <span>/{r.slug}</span>
                <span className="truncate text-text-faint">{r.blurb}</span>
              </button>
            </li>
          ))}
          {ranked.length === 0 && <li className="px-3 py-2 font-mono text-[12px] text-text-faint">no match</li>}
        </ul>
      )}
    </div>
  );
}

function Account() {
  const { user, isTom } = useAuth();
  const displayName = getUsername(user);
  const [loginOpen, setLoginOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  return (
    <>
      {user ? (
        <button
          type="button"
          onClick={() => setProfileOpen(true)}
          className={`h-7 shrink-0 whitespace-nowrap rounded-control border px-2 text-[12px] hover:border-text-muted hover:text-text ${
            isTom ? "border-accent text-accent" : "border-border text-text-muted"
          }`}
        >
          {displayName}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setLoginOpen(true)}
          className="h-7 shrink-0 whitespace-nowrap rounded-control border border-border px-2 text-[12px] text-text-muted hover:border-text-muted hover:text-text"
        >
          Log in
        </button>
      )}
      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
      <ProfileModal isOpen={profileOpen} onClose={() => setProfileOpen(false)} displayName={displayName} />
    </>
  );
}

export default function SiteBar({
  title,
  explainer,
  state,
  after,
  topToggle,
}: {
  title: string;
  explainer: ExplainerId;
  state?: string;
  /** Anything the page segment holds after the state line. */
  after?: ReactNode;
  /** The top drawer's toggle, which fills the rail between the page name and navigate. */
  topToggle: ReactNode;
}) {
  return (
    <div className="flex h-full items-stretch">
      <Link
        href="/"
        aria-label="tom.Quest home"
        className="flex w-10 shrink-0 items-center justify-center hover:bg-surface-alt sm:w-(--frame-corner)"
      >
        <TomQuestSymbol size={20} />
      </Link>
      <div className="flex min-w-0 shrink items-center gap-2 pl-2 pr-3">
        <h1 className="truncate text-[13px] font-semibold text-text">{title}</h1>
        <Info explainer={explainer} />
        {state && <span className="hidden truncate text-[12px] text-text-muted sm:inline">{state}</span>}
        {after}
      </div>
      {topToggle}
      <div className="flex shrink-0 items-center gap-2 pl-2 pr-1">
        <Navigate />
        <Account />
      </div>
    </div>
  );
}
