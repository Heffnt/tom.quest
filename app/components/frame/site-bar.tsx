"use client";

// The site's controls, which ride on the top drawer's handle: at its start the
// logo in the top-left corner (home), the page name with its (i) and a
// one-line state; at its end the variant picker, a compact navigate field
// ("/" focuses it), the account button and the Tom-only diagnostics dot. They
// replace NavTerm on a frame page and share its navigate state
// (use-nav-search.ts). The frame places them like any handle's buttons: each
// control keeps its pointer to itself, so pressing one never moves the drawer.

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getUsername, useAuth } from "@/app/lib/auth";
import { useDiagnosticsStatus } from "../debug-panel";
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
      <div className="flex h-6 items-center gap-2 rounded-control border border-border bg-bg px-2 font-mono focus-within:border-accent/80">
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
        <ul className="absolute right-0 top-7 w-80 overflow-hidden rounded-panel border border-border bg-surface shadow-xl">
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
          className={`h-6 shrink-0 whitespace-nowrap rounded-control border px-2 text-[12px] hover:border-text-muted hover:text-text ${
            isTom ? "border-accent text-accent" : "border-border text-text-muted"
          }`}
        >
          {displayName}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setLoginOpen(true)}
          className="h-6 shrink-0 whitespace-nowrap rounded-control border border-border px-2 text-[12px] text-text-muted hover:border-text-muted hover:text-text"
        >
          Log in
        </button>
      )}
      {/* The handle moves with a transform, which would pin a fixed dialog
          inside it; the dialogs render at the body instead. */}
      {loginOpen && createPortal(<LoginModal isOpen onClose={() => setLoginOpen(false)} />, document.body)}
      {profileOpen &&
        createPortal(
          <ProfileModal isOpen onClose={() => setProfileOpen(false)} displayName={displayName} />,
          document.body,
        )}
    </>
  );
}

/** The Tom-only dot: Convex's connection and any captured console error; pressing it opens the bottom drawer, which holds the diagnostics. */
function DiagnosticsDot({ onOpen }: { onOpen: () => void }) {
  const { convex, events } = useDiagnosticsStatus();
  const errors = events.filter((e) => e.level === "error").length;
  const tone = convex === "disconnected" ? "bg-error" : errors > 0 ? "bg-warning" : "bg-success";
  return (
    <button
      type="button"
      data-frame-diagnostics
      onClick={onOpen}
      aria-label={`Diagnostics: Convex ${convex}, ${errors} console errors`}
      className="flex h-full w-(--frame-handle) shrink-0 items-center justify-center hover:bg-surface-alt"
    >
      <span className={`h-2 w-2 rounded-full ${tone}`} />
    </button>
  );
}

/**
 * One thing on a handle besides its label and signals. A control keeps the
 * pointer to itself, so pressing it never opens, closes or drags the drawer; a
 * plain label lets the press through to the handle.
 */
export type HandleSlot = { key: string; node: ReactNode; control: boolean };

/**
 * The site's slots on the top handle. At the start: the logo in the corner,
 * the page name, its (i) and its state. At the end: the variant picker,
 * navigate, the account and, for Tom, the diagnostics dot.
 */
export function siteSlots({
  title,
  explainer,
  state,
  picker,
  isTom,
  onDiagnostics,
}: {
  title: string;
  explainer: ExplainerId;
  state?: string;
  picker: ReactNode;
  isTom: boolean;
  onDiagnostics: () => void;
}): { start: HandleSlot[]; end: HandleSlot[] } {
  const start: HandleSlot[] = [
    {
      key: "home",
      control: true,
      node: (
        <Link
          href="/"
          aria-label="tom.Quest home"
          className="flex h-full w-(--frame-handle) shrink-0 items-center justify-center hover:bg-surface-alt"
        >
          <TomQuestSymbol size={18} />
        </Link>
      ),
    },
    { key: "title", control: false, node: <h1 className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-text">{title}</h1> },
    { key: "info", control: true, node: <Info explainer={explainer} /> },
  ];
  if (state) {
    start.push({
      key: "state",
      control: false,
      node: <span className="hidden shrink-0 whitespace-nowrap text-[12px] text-text-muted sm:inline">{state}</span>,
    });
  }
  const end: HandleSlot[] = [
    { key: "picker", control: true, node: picker },
    { key: "navigate", control: true, node: <Navigate /> },
    { key: "account", control: true, node: <Account /> },
  ];
  if (isTom) end.push({ key: "diagnostics", control: true, node: <DiagnosticsDot onOpen={onDiagnostics} /> });
  return { start, end };
}
