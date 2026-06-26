"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { BrewState } from "../lib/types";
import {
  effectiveTally,
  availableMarkers,
  msFromList,
} from "../lib/engine";
import {
  ALL_TOKENS,
  isNamed,
  NAMED,
} from "../data/base";
import { FrequencySymbol, STRIKE, COPPER, namedColor, fundColor } from "../lib/frequencies";
import IngredientThumb from "./ingredient-thumb";

export interface CauldronProps {
  brew: BrewState;
  brewCounts: { key: string; name: string; color: string; count: number }[];
  onInc: (key: string) => void;
  onDec: (key: string) => void;
  onStrike: (id: string) => void;
  onUnstrike: (id: string) => void;
  onSummon: (id: string) => void;
  onUnsummon: (id: string) => void;
  onClear: () => void;
}

// Deterministic [0,1) hash from a string, so a token keeps a stable position
// and animation across re-renders (positions are keyed by token identity).
function hash01(str: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // map to [0,1)
  return ((h >>> 0) % 100000) / 100000;
}

type FloatKind = "freq" | "ghost" | "strike" | "wild";
type Floater = {
  uid: string;
  kind: FloatKind;
  id?: string; // token id for freq/ghost
  summoned?: boolean; // freq summoned via a wildcard (undo-able)
};

// Place a floater in an elliptical band above the cauldron brew.
function floaterStyle(uid: string): React.CSSProperties {
  const rx = hash01(uid, 1);
  const ry = hash01(uid, 2);
  const left = 8 + rx * 84; // 8%..92%
  const top = 3 + ry * 56; //  3%..59%
  const dx = (hash01(uid, 3) - 0.5) * 26; // px drift
  const dy = -8 - hash01(uid, 4) * 20;
  const rot = (hash01(uid, 5) - 0.5) * 16;
  const dur = 4.5 + hash01(uid, 6) * 5; // 4.5s..9.5s
  const delay = -hash01(uid, 7) * 6; // negative => desync start
  return {
    left: `${left}%`,
    top: `${top}%`,
    ["--pf-dx" as string]: `${dx}px`,
    ["--pf-dy" as string]: `${dy}px`,
    ["--pf-rot" as string]: `${rot}deg`,
    ["--pf-dur" as string]: `${dur}s`,
    ["--pf-delay" as string]: `${delay}s`,
  };
}

export default function Cauldron({
  brew,
  brewCounts,
  onInc,
  onDec,
  onStrike,
  onUnstrike,
  onSummon,
  onUnsummon,
  onClear,
}: CauldronProps) {
  const eff = useMemo(() => effectiveTally(brew), [brew]);
  const avail = useMemo(() => availableMarkers(brew), [brew]);
  const summonedMs = useMemo(() => msFromList(brew.plusPlays), [brew.plusPlays]);
  const struckMs = useMemo(() => msFromList(brew.minusPlays), [brew.minusPlays]);

  // Build the floaters: effective tokens (normal, some marked summoned),
  // ghosts (struck-out tokens), and unspent strike / wildcard charges.
  const floaters = useMemo<Floater[]>(() => {
    const out: Floater[] = [];
    const effKeys = Object.keys(eff).sort();
    for (const id of effKeys) {
      const total = eff[id];
      const summonedCount = Math.min(summonedMs[id] ?? 0, total);
      for (let i = 0; i < total; i++) {
        out.push({
          uid: `f:${id}:${i}`,
          kind: "freq",
          id,
          summoned: i >= total - summonedCount,
        });
      }
    }
    for (const id of Object.keys(struckMs).sort()) {
      for (let i = 0; i < struckMs[id]; i++) {
        out.push({ uid: `g:${id}:${i}`, kind: "ghost", id });
      }
    }
    for (let i = 0; i < avail.minus; i++) {
      out.push({ uid: `s:${i}`, kind: "strike" });
    }
    for (let i = 0; i < avail.plus; i++) {
      out.push({ uid: `w:${i}`, kind: "wild" });
    }
    return out;
  }, [eff, summonedMs, struckMs, avail.minus, avail.plus]);

  const totalFreq = useMemo(
    () => Object.values(eff).reduce((a, b) => a + b, 0),
    [eff],
  );

  // ---- strike drag-and-drop ----
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const dragInfo = useRef<{ moved: boolean; startX: number; startY: number }>({
    moved: false,
    startX: 0,
    startY: 0,
  });

  const hitTokenAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    const t = el?.closest?.("[data-drop-token]");
    return t ? t.getAttribute("data-drop-token") : null;
  };

  const onStrikePointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragInfo.current = { moved: false, startX: e.clientX, startY: e.clientY };
    setDrag({ x: e.clientX, y: e.clientY });
  };
  const onStrikePointerMove = (e: ReactPointerEvent) => {
    if (drag === null) return;
    const dx = e.clientX - dragInfo.current.startX;
    const dy = e.clientY - dragInfo.current.startY;
    if (Math.hypot(dx, dy) > 5) dragInfo.current.moved = true;
    setDrag({ x: e.clientX, y: e.clientY });
    setHoverTarget(hitTokenAt(e.clientX, e.clientY));
  };
  const onStrikePointerUp = (e: ReactPointerEvent) => {
    if (drag === null) return;
    const targetUid = hitTokenAt(e.clientX, e.clientY);
    if (dragInfo.current.moved) {
      if (targetUid) {
        const target = floaters.find((fl) => fl.uid === targetUid);
        if (target?.id) onStrike(target.id);
      }
      setArmed(false);
    } else {
      // a tap (no drag): toggle armed mode for click-to-apply
      setArmed((a) => !a);
    }
    setDrag(null);
    setHoverTarget(null);
  };
  const onStrikePointerCancel = () => {
    setDrag(null);
    setHoverTarget(null);
  };

  const onFreqClick = (f: Floater) => {
    if (!f.id) return;
    // A summoned token is dispelled (refunds the ⊕), never struck — striking it
    // would waste a ⊖ since the engine applies strikes before summons.
    if (f.summoned) {
      onUnsummon(f.id);
      setArmed(false);
      return;
    }
    if (armed) {
      onStrike(f.id);
      setArmed(false);
    }
  };

  // a strike can't be left armed once there are no charges to spend
  useEffect(() => {
    if (avail.minus === 0) setArmed(false);
  }, [avail.minus]);

  // ---- wildcard picker ----
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const openPicker = (e: ReactMouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPicker({ x: r.left + r.width / 2, y: r.bottom + 6 });
  };

  return (
    <div className="relative flex h-full flex-col">
      {/* status bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 font-mono text-xs text-text-muted">
        <span className="uppercase tracking-[0.3em] text-text-faint">The Cauldron</span>
        <div className="flex items-center gap-3 tabular-nums">
          <span title="frequencies in the brew">
            <span className="text-text">{totalFreq}</span> freq
          </span>
          <span title="unspent strikes" style={{ color: avail.minus ? STRIKE : undefined }}>
            ⊖ {avail.minus}
          </span>
          <span title="unspent wildcards" style={{ color: avail.plus ? COPPER : undefined }}>
            ⊕ {avail.plus}
          </span>
          <button
            type="button"
            onClick={onClear}
            disabled={brewCounts.length === 0}
            className="rounded-md border border-border px-2 py-1 text-text-muted transition-colors duration-150 hover:border-text-muted hover:text-text disabled:opacity-40"
          >
            empty
          </button>
        </div>
      </div>

      {/* stage: floating tokens + the vessel */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* float field */}
        <div className="absolute inset-x-0 top-0 bottom-[34%] z-10">
          {floaters.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center font-mono text-sm text-text-faint">
              add ingredients to conjure their frequencies…
            </div>
          )}
          {floaters.map((f) => {
            if (f.kind === "strike") {
              return (
                <button
                  key={f.uid}
                  type="button"
                  onPointerDown={onStrikePointerDown}
                  onPointerMove={onStrikePointerMove}
                  onPointerUp={onStrikePointerUp}
                  onPointerCancel={onStrikePointerCancel}
                  aria-label="Strike — drag onto a frequency to remove it"
                  title="Strike: drag onto a frequency to remove it"
                  className={`pf-float absolute grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none select-none place-items-center rounded-full border text-sm font-bold active:cursor-grabbing ${
                    armed ? "ring-2 ring-offset-2 ring-offset-bg" : ""
                  }`}
                  style={{
                    ...floaterStyle(f.uid),
                    borderColor: STRIKE,
                    color: STRIKE,
                    background: "#a855f71a",
                    boxShadow: `0 0 14px ${STRIKE}55`,
                    ...(armed ? ({ ["--tw-ring-color" as string]: STRIKE } as React.CSSProperties) : {}),
                  }}
                >
                  ⊖
                </button>
              );
            }
            if (f.kind === "wild") {
              return (
                <button
                  key={f.uid}
                  type="button"
                  onClick={openPicker}
                  aria-label="Wildcard — click to choose a frequency to summon"
                  title="Wildcard: click to summon any frequency"
                  className="pf-float absolute grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full border text-sm font-bold"
                  style={{
                    ...floaterStyle(f.uid),
                    borderColor: COPPER,
                    color: COPPER,
                    background: "#c98a3c1a",
                    boxShadow: `0 0 14px ${COPPER}55`,
                  }}
                >
                  ⊕
                </button>
              );
            }
            // freq or ghost
            const ghost = f.kind === "ghost";
            return (
              <div
                key={f.uid}
                {...(!ghost && !f.summoned ? { "data-drop-token": f.uid } : {})}
                onClick={() => {
                  if (ghost) {
                    onUnstrike(f.id!);
                    setArmed(false);
                  } else {
                    onFreqClick(f);
                  }
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (ghost) {
                      onUnstrike(f.id!);
                      setArmed(false);
                    } else {
                      onFreqClick(f);
                    }
                  }
                }}
                aria-label={
                  ghost
                    ? `${f.id} removed — click to restore`
                    : `${f.id} frequency${f.summoned ? ", summoned — click to dispel" : ""}`
                }
                title={
                  ghost
                    ? `${f.id} — struck out (click to restore)`
                    : f.summoned
                      ? `${f.id} — summoned (click to dispel)`
                      : f.id
                }
                className={`pf-float pf-pop absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full transition-[filter,opacity] ${
                  hoverTarget === f.uid ? "ring-2 ring-offset-2 ring-offset-bg" : ""
                }`}
                style={{
                  ...floaterStyle(f.uid),
                  opacity: ghost ? 0.34 : 1,
                  filter: ghost ? "grayscale(1)" : "none",
                  ...(hoverTarget === f.uid
                    ? ({ ["--tw-ring-color" as string]: STRIKE } as React.CSSProperties)
                    : {}),
                }}
              >
                <FrequencySymbol id={f.id!} size={36} />
                {f.summoned && (
                  <span
                    className="absolute -right-1 -top-1 grid h-3.5 w-3.5 place-items-center rounded-full text-[8px] font-bold"
                    style={{ background: COPPER, color: "#14132B" }}
                  >
                    ⊕
                  </span>
                )}
                {ghost && (
                  <span
                    className="pointer-events-none absolute inset-0 grid place-items-center text-lg font-bold"
                    style={{ color: STRIKE }}
                  >
                    ⊘
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* the vessel */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 flex h-[40%] items-end justify-center">
          <CauldronVessel active={totalFreq > 0} />
        </div>
      </div>

      {/* brew tray — the ingredients currently in the pot */}
      <div className="border-t border-border px-3 py-2">
        {brewCounts.length === 0 ? (
          <p className="py-1 text-center font-mono text-xs text-text-faint">
            the cauldron is empty
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {brewCounts.map((b) => (
              <span
                key={b.key}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pl-1 pr-1 text-xs"
              >
                <IngredientThumb
                  name={b.name}
                  source={b.key.startsWith("base:") ? { kind: "base" } : { kind: "user", userId: "", name: "" }}
                  color={b.color}
                  size={22}
                />
                <span className="max-w-[150px] truncate text-text">{b.name}</span>
                <span className="flex items-center gap-0.5 font-mono">
                  <button
                    type="button"
                    onClick={() => onDec(b.key)}
                    aria-label={`Remove one ${b.name}`}
                    className="grid h-4 w-4 place-items-center rounded text-text-muted hover:bg-surface-alt hover:text-text"
                  >
                    −
                  </button>
                  <span className="w-4 text-center tabular-nums text-text-muted">{b.count}</span>
                  <button
                    type="button"
                    onClick={() => onInc(b.key)}
                    aria-label={`Add another ${b.name}`}
                    className="grid h-4 w-4 place-items-center rounded text-text-muted hover:bg-surface-alt hover:text-text"
                  >
                    +
                  </button>
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* drag ghost following the cursor */}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border text-base font-bold"
          style={{
            left: drag.x,
            top: drag.y,
            borderColor: STRIKE,
            color: STRIKE,
            background: "#14132B",
            boxShadow: `0 0 18px ${STRIKE}aa`,
          }}
        >
          ⊖
        </div>
      )}

      {picker && (
        <WildcardPicker
          x={picker.x}
          y={picker.y}
          onPick={(id) => {
            onSummon(id);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function CauldronVessel({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 260 180"
      className="h-full max-h-[260px] w-auto"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="pf-brew" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#9bf6df" />
          <stop offset="55%" stopColor="#6FE3C4" />
          <stop offset="100%" stopColor="#2f9c84" />
        </radialGradient>
        <linearGradient id="pf-pot" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#262549" />
          <stop offset="100%" stopColor="#14132B" />
        </linearGradient>
      </defs>

      {/* steam */}
      {active && (
        <g style={{ transformOrigin: "center" }}>
          <ellipse className="pf-steam" style={{ ["--pf-dur" as string]: "5s" }} cx="105" cy="60" rx="6" ry="10" fill="#6FE3C4" opacity="0.25" />
          <ellipse className="pf-steam" style={{ ["--pf-dur" as string]: "6.5s", ["--pf-delay" as string]: "-2s" }} cx="135" cy="58" rx="7" ry="12" fill="#6FE3C4" opacity="0.2" />
          <ellipse className="pf-steam" style={{ ["--pf-dur" as string]: "5.8s", ["--pf-delay" as string]: "-3.5s" }} cx="120" cy="55" rx="5" ry="9" fill="#9bf6df" opacity="0.18" />
        </g>
      )}

      {/* rim */}
      <ellipse cx="130" cy="78" rx="92" ry="20" fill="url(#pf-pot)" stroke="#3a3866" strokeWidth="2" />
      {/* brew surface */}
      <ellipse
        cx="130"
        cy="76"
        rx="80"
        ry="15"
        fill={active ? "url(#pf-brew)" : "#1b2a3a"}
        className={active ? "pf-glow" : ""}
      />
      {/* bubbles */}
      {active && (
        <g>
          <circle className="pf-bubble" style={{ ["--pf-dur" as string]: "2.6s" }} cx="112" cy="74" r="3" fill="#bff7e8" />
          <circle className="pf-bubble" style={{ ["--pf-dur" as string]: "3.2s", ["--pf-delay" as string]: "-1s" }} cx="140" cy="76" r="4" fill="#bff7e8" />
          <circle className="pf-bubble" style={{ ["--pf-dur" as string]: "2.9s", ["--pf-delay" as string]: "-1.8s" }} cx="128" cy="72" r="2.5" fill="#e8fff8" />
        </g>
      )}

      {/* pot body */}
      <path
        d="M40 80 C40 150 75 172 130 172 C185 172 220 150 220 80 C200 96 165 104 130 104 C95 104 60 96 40 80 Z"
        fill="url(#pf-pot)"
        stroke="#3a3866"
        strokeWidth="2.5"
      />
      {/* belly highlight */}
      <path d="M60 96 C70 130 95 150 130 154" fill="none" stroke="#4b4980" strokeWidth="3" strokeLinecap="round" opacity="0.5" />
      {/* ears */}
      <ellipse cx="42" cy="86" rx="8" ry="12" fill="none" stroke="#3a3866" strokeWidth="4" />
      <ellipse cx="218" cy="86" rx="8" ry="12" fill="none" stroke="#3a3866" strokeWidth="4" />
      {/* legs */}
      <path d="M86 170 l-8 10 M174 170 l8 10 M130 174 l0 10" stroke="#3a3866" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

function WildcardPicker({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const query = q.trim().toLowerCase();
  const items = useMemo(
    () =>
      ALL_TOKENS.filter((t) => {
        if (!query) return true;
        if (t.id.toLowerCase().includes(query)) return true;
        if (isNamed(t.id) && (NAMED[t.id]?.icon ?? "").toLowerCase().includes(query)) return true;
        return false;
      }),
    [query],
  );

  // keep the popover on-screen
  const left = Math.min(Math.max(x - 130, 8), (typeof window !== "undefined" ? window.innerWidth : 1024) - 268);
  const top = Math.max(8, Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 768) - 360));

  return (
    <div
      ref={ref}
      className="fixed z-50 w-[260px] rounded-lg border border-border bg-surface shadow-xl"
      style={{ left, top }}
      role="dialog"
      aria-label="Summon a frequency"
    >
      <div className="border-b border-border p-2">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="summon frequency…"
          spellCheck={false}
          className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
        />
      </div>
      <div className="max-h-[260px] overflow-y-auto p-1">
        {items.length === 0 && (
          <p className="px-2 py-3 text-center font-mono text-xs text-text-faint">no match</p>
        )}
        <div className="grid grid-cols-1">
          {items.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(t.id)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-alt"
            >
              <FrequencySymbol id={t.id} size={22} />
              <span className="font-mono text-sm text-text">{t.id}</span>
              <span
                className="ml-auto text-[10px] uppercase tracking-wider text-text-faint"
                style={{ color: t.kind === "named" ? (isNamed(t.id) ? namedColor(t.id) : undefined) : fundColor(t.id) }}
              >
                {t.kind}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
