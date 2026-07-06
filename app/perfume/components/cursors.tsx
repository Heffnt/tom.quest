"use client";

// Presence (DESIGN.md §6): everyone viewing a brew sees everyone else's cursor
// (name + color) and held stack, ON THE STAGE. Coordinates travel in
// content-space per surface — input/book: x as 0..1 of content width, y as
// px-from-content-top/1000 (scroll-aware); stage: its 0-100 percent space — so
// viewers with different panel widths and scroll positions still see the cursor
// over the same thing. When a member's cursor leaves the stage it freezes at
// its last position (the store keeps returning it, marked stale) rather than
// vanishing. Only mounted in Convex mode, and only for a real (resolved) brew.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Hand, PresenceEntry, PresenceSurface } from "../lib/legacy-adapter";
import { ItemIcon } from "../lib/use-hand";
import { itemInfo } from "../lib/brew-store";

const SEND_MS = 50; // ~20Hz
const SURFACE_SELECTOR = "[data-pf-surface]";

function makeClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

type Located = { surface: PresenceSurface; x: number; y: number };

// viewport point -> content-space, via the surface under the pointer
function locate(x: number, y: number): Located | null {
  const el = document
    .elementFromPoint(x, y)
    ?.closest(SURFACE_SELECTOR) as HTMLElement | null;
  if (!el) return null;
  const surface = el.getAttribute("data-pf-surface") as PresenceSurface | null;
  if (!surface) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  if (surface === "stage") {
    return {
      surface,
      x: ((x - r.left) / r.width) * 100,
      y: ((y - r.top) / r.height) * 100,
    };
  }
  return {
    surface,
    x: (x - r.left) / r.width,
    y: (y - r.top + el.scrollTop) / 1000,
  };
}

// content-space -> viewport point (null when the surface is not on the page)
function project(surface: PresenceSurface, x: number, y: number): { x: number; y: number } | null {
  const el = document.querySelector(
    `[data-pf-surface="${surface}"]`,
  ) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  if (surface === "stage") {
    return { x: r.left + (x / 100) * r.width, y: r.top + (y / 100) * r.height };
  }
  return { x: r.left + x * r.width, y: r.top + y * 1000 - el.scrollTop };
}

export interface CursorsProps {
  /** The resolved brew id on stage; null while the party brew resolves. */
  brewId: string | null;
  /** false until the viewer can identify (auth resolved / anon id minted). */
  identified: boolean;
  anonId: string | null;
  name: string;
  color: string;
  hand: Hand | null;
  /** Live presence rows from the store (fresh + frozen-stale). */
  entries: PresenceEntry[];
}

export default function Cursors({
  brewId,
  identified,
  anonId,
  name,
  color,
  hand,
  entries,
}: CursorsProps) {
  const [clientId] = useState(makeClientId);
  const heartbeat = useMutation(api.brews.heartbeat);

  // ── sender: pointermove throttled to ~20Hz, plus hand-change pings ────────
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const lastSent = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef({ brewId, identified, anonId, name, color, hand });
  stateRef.current = { brewId, identified, anonId, name, color, hand };

  const send = useCallback(() => {
    const s = stateRef.current;
    const pos = lastPos.current;
    if (!s.identified || !s.brewId || !pos) return;
    const loc = locate(pos.x, pos.y);
    if (!loc) return;
    lastSent.current = Date.now();
    void heartbeat({
      brewId: s.brewId as Id<"perfumeBrews">,
      clientId,
      color: s.color,
      surface: loc.surface,
      x: loc.x,
      y: loc.y,
      hand: s.hand ? { key: s.hand.itemKey, count: s.hand.count } : undefined,
      ...(s.anonId ? { anonId: s.anonId } : {}),
    }).catch(() => {
      // presence is best-effort telemetry
    });
  }, [heartbeat, clientId]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      lastPos.current = { x: e.clientX, y: e.clientY };
      const wait = lastSent.current + SEND_MS - Date.now();
      if (wait <= 0) send();
      else if (!trailing.current) {
        trailing.current = setTimeout(() => {
          trailing.current = null;
          send();
        }, wait);
      }
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (trailing.current) clearTimeout(trailing.current);
    };
  }, [send]);

  // picking up / settling without moving still updates the held stack
  const handKey = hand ? `${hand.itemKey}:${hand.count}` : "";
  useEffect(() => {
    send();
  }, [handKey, brewId, send]);

  // ── renderer: re-project on scroll/resize ─────────────────────────────────
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const tick = () => bump();
    const interval = setInterval(tick, 2000);
    window.addEventListener("scroll", tick, true);
    window.addEventListener("resize", tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener("scroll", tick, true);
      window.removeEventListener("resize", tick);
    };
  }, []);

  if (typeof window === "undefined") return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  return (
    <>
      {entries
        .filter((e) => e.clientId !== clientId)
        // presence cursors render ON THE STAGE ONLY (DESIGN.md §6). locate()
        // still reports the input/book surfaces so a cursor that leaves the
        // stage freezes at its last STAGE position (kept stale by the store)
        // rather than following the member onto another surface.
        .filter((e) => e.surface === "stage")
        .map((e) => {
          const p = project(e.surface, e.x, e.y);
          if (!p) return null;
          const off = p.x < 0 || p.x > vw || p.y < 0 || p.y > vh;
          if (off) {
            const x = Math.min(Math.max(p.x, 14), vw - 14);
            const y = Math.min(Math.max(p.y, 14), vh - 14);
            return (
              <div
                key={e.clientId}
                className="pointer-events-none fixed z-[88] -translate-x-1/2 -translate-y-1/2"
                style={{ left: x, top: y, opacity: e.stale ? 0.5 : 1 }}
                title={`${e.name} is over here`}
                aria-hidden="true"
              >
                <span
                  className="grid h-4 w-4 place-items-center rounded-full border border-bg font-mono text-[8px] font-bold text-bg shadow"
                  style={{ background: e.color }}
                >
                  {e.name.slice(0, 1).toUpperCase()}
                </span>
              </div>
            );
          }
          return (
            <div
              key={e.clientId}
              className="pointer-events-none fixed z-[88]"
              style={{ left: p.x, top: p.y, opacity: e.stale ? 0.5 : 1 }}
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 16 16"
                width={14}
                height={14}
                className="-translate-x-[2px] -translate-y-[2px] drop-shadow"
              >
                <path
                  d="M2 1.5 13.5 8 8 9.3 5.6 14.6Z"
                  fill={e.color}
                  stroke="#14132B"
                  strokeWidth="1"
                />
              </svg>
              <div className="flex items-center gap-1 pl-3">
                <span
                  className="max-w-[120px] truncate rounded-full px-1.5 py-0.5 font-mono text-[9px] font-semibold leading-none text-bg shadow"
                  style={{ background: e.color }}
                >
                  {e.name}
                </span>
                {e.hand && (
                  <span className="relative inline-flex" title={itemInfo(e.hand.key).name}>
                    <ItemIcon
                      itemKey={e.hand.key}
                      name={itemInfo(e.hand.key).name}
                      color={itemInfo(e.hand.key).color}
                      size={26}
                    />
                    {e.hand.count > 1 && (
                      <span className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-surface px-1 font-mono text-[9px] font-bold text-text">
                        ×{e.hand.count}
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>
          );
        })}
    </>
  );
}
