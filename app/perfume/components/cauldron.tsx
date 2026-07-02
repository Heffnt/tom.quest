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
  FUND,
  isNamed,
  NAMED,
} from "../data/base";
import {
  FrequencySymbol,
  STRIKE,
  COPPER,
  namedColor,
  fundColor,
  tokenColor,
} from "../lib/frequencies";
import IngredientThumb from "./ingredient-thumb";

// The name printed under a floating token: school for fundamentals, the tone's
// own name for named frequencies.
function tokenLabel(id: string): string {
  return isNamed(id) ? id : (FUND[id]?.school ?? id);
}

export interface CauldronProps {
  brew: BrewState;
  brewCounts: { key: string; name: string; color: string; count: number }[];
  // names of the perfumes the current brew bottles exactly (perfect matches)
  bottled: string[];
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

type Src = { key: string; name: string; color: string };

type FloatKind = "freq" | "ghost" | "strike" | "wild";
type Floater = {
  uid: string;
  kind: FloatKind;
  id?: string; // token id for freq/ghost
  summoned?: boolean; // freq summoned via a wildcard (undo-able)
  // the ingredient this token came from; for summoned tokens and unspent
  // charges it is the ingredient that GRANTED the ⊕/⊖ (charges are spent in
  // brew order, matching how the engine caps plays to marker totals)
  src?: Src;
};

type Slot = { x: number; y: number; angle: number };

// The stage is one coordinate space (percentages of the stage box):
// frequency arc up top, ingredient arc below it, the vessel at the bottom.
// MOUTH is where the connective lines rise out of the pot.
const MOUTH = { x: 50, y: 78 };

// Fan the frequency tokens into a "hand of cards" arc high above the cauldron.
function tokenArcSlot(i: number, n: number): Slot {
  if (n <= 1) return { x: 50, y: 20, angle: 0 };
  const STEP = 0.27; // ~15.5° between adjacent cards
  const MAX_FAN = 2.25; // ~129° widest total spread
  const step = Math.min(STEP, MAX_FAN / (n - 1));
  const a = (i - (n - 1) / 2) * step; // radians, centered on 0
  const RX = 38; // horizontal radius (% of stage width)
  const RY = 34; // vertical radius (taller -> a more pronounced arc)
  const pivotY = 54; // arc pivots from below, opening upward
  return {
    x: 50 + RX * Math.sin(a),
    y: pivotY - RY * Math.cos(a),
    angle: ((a * 180) / Math.PI) * 0.55, // damped card tilt
  };
}

// A gentler fan for the ingredients, hugging the cauldron's rim.
function ingArcSlot(i: number, n: number): Slot {
  if (n <= 1) return { x: 50, y: 58, angle: 0 };
  const STEP = 0.34;
  const MAX_FAN = 1.9; // ~109°
  const step = Math.min(STEP, MAX_FAN / (n - 1));
  const a = (i - (n - 1) / 2) * step;
  const RX = 38;
  const RY = 34;
  const pivotY = 92;
  return {
    x: 50 + RX * Math.sin(a),
    y: pivotY - RY * Math.cos(a),
    angle: ((a * 180) / Math.PI) * 0.35,
  };
}

// Gentle in-place bob, deterministic per token so it stays stable across renders.
function driftStyle(uid: string): React.CSSProperties {
  const dx = (hash01(uid, 3) - 0.5) * 10; // ±5px
  const dy = -4 - hash01(uid, 4) * 6; // -4..-10px
  const rot = (hash01(uid, 5) - 0.5) * 6; // ±3deg
  const dur = 3.5 + hash01(uid, 6) * 3; // 3.5..6.5s
  const delay = -hash01(uid, 7) * 5; // desync start
  return {
    ["--pf-dx" as string]: `${dx}px`,
    ["--pf-dy" as string]: `${dy}px`,
    ["--pf-rot" as string]: `${rot}deg`,
    ["--pf-dur" as string]: `${dur}s`,
    ["--pf-delay" as string]: `${delay}s`,
  };
}

// How an ingredient looks in the arc / tray: base ingredients show their PDF
// crest; pure frequencies show the frequency symbol itself (or the ⊖/⊕ glyph
// for a pure strike / pure wild).
function IngredientVisual({
  keyId,
  name,
  color,
  size,
}: {
  keyId: string;
  name: string;
  color: string;
  size: number;
}) {
  if (keyId.startsWith("pure:")) {
    const id = keyId.slice(5);
    if (id === "strike" || id === "wild") {
      const c = id === "strike" ? STRIKE : COPPER;
      return (
        <span
          aria-hidden="true"
          className="grid shrink-0 place-items-center rounded-full border font-bold"
          style={{
            width: size,
            height: size,
            borderColor: c,
            color: c,
            background: `${c}1a`,
            fontSize: Math.round(size * 0.45),
          }}
        >
          {id === "strike" ? "⊖" : "⊕"}
        </span>
      );
    }
    return <FrequencySymbol id={id} size={size} />;
  }
  return (
    <IngredientThumb
      name={name}
      source={
        keyId.startsWith("base:")
          ? { kind: "base" }
          : { kind: "user", userId: "", name: "" }
      }
      color={color}
      size={size}
    />
  );
}

export default function Cauldron({
  brew,
  brewCounts,
  bottled,
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
  const struckMs = useMemo(() => msFromList(brew.strikePlays), [brew.strikePlays]);

  // One arc node per distinct ingredient in the pot (with a ×n count).
  const ingNodes = useMemo(() => {
    const order: string[] = [];
    const info = new Map<string, Src & { count: number }>();
    for (const ing of brew.ingredients) {
      if (!info.has(ing.key)) {
        order.push(ing.key);
        info.set(ing.key, { key: ing.key, name: ing.name, color: ing.color, count: 0 });
      }
      info.get(ing.key)!.count++;
    }
    return order.map((k) => info.get(k)!);
  }, [brew.ingredients]);

  // Build the floaters for the frequency arc: every emitted token attributed
  // to the ingredient that contributed it (strikes ghost the LAST instances of
  // a token id, mirroring the engine's id-level strikes), then summoned tokens
  // (attributed to the ⊕-granting ingredient), then unspent ⊖/⊕ charges
  // (attributed to their granting ingredient; charges are spent in brew order).
  const floaters = useMemo<Floater[]>(() => {
    const out: Floater[] = [];
    const instances: Record<string, Src[]> = {};
    const strikeSources: Src[] = [];
    const wildSources: Src[] = [];
    for (const ing of brew.ingredients) {
      const src: Src = { key: ing.key, name: ing.name, color: ing.color };
      for (const tok of ing.emits) (instances[tok] ??= []).push(src);
      for (let i = 0; i < ing.strike; i++) strikeSources.push(src);
      for (let i = 0; i < ing.wild; i++) wildSources.push(src);
    }
    for (const id of Object.keys(instances).sort()) {
      const list = instances[id];
      const struck = Math.min(struckMs[id] ?? 0, list.length);
      list.forEach((src, i) => {
        const ghost = i >= list.length - struck;
        out.push({
          uid: `${ghost ? "g" : "f"}:${id}:${i}`,
          kind: ghost ? "ghost" : "freq",
          id,
          src,
        });
      });
    }
    const perId: Record<string, number> = {};
    brew.wildPlays.forEach((id, i) => {
      const n = (perId[id] = (perId[id] ?? 0) + 1);
      out.push({ uid: `p:${id}:${n}`, kind: "freq", id, summoned: true, src: wildSources[i] });
    });
    for (let i = brew.strikePlays.length; i < strikeSources.length; i++) {
      out.push({ uid: `s:${i}`, kind: "strike", src: strikeSources[i] });
    }
    for (let i = brew.wildPlays.length; i < wildSources.length; i++) {
      out.push({ uid: `w:${i}`, kind: "wild", src: wildSources[i] });
    }
    return out;
  }, [brew.ingredients, brew.wildPlays, brew.strikePlays, struckMs]);

  const totalFreq = useMemo(
    () => Object.values(eff).reduce((a, b) => a + b, 0),
    [eff],
  );

  // ---- layout: slots for both arcs + the connective lines ----
  const layout = useMemo(() => {
    const tokenSlots = floaters.map((_, i) => tokenArcSlot(i, floaters.length));
    const ingSlots = ingNodes.map((_, i) => ingArcSlot(i, ingNodes.length));
    const slotByIng = new Map(ingNodes.map((g, i) => [g.key, ingSlots[i]]));
    type Edge = {
      key: string;
      d: string;
      color: string;
      dashed: boolean;
      opacity: number;
      width: number;
      ingKey?: string;
    };
    const edges: Edge[] = [];
    // stems: cauldron mouth -> each ingredient
    ingNodes.forEach((g, i) => {
      const s = ingSlots[i];
      edges.push({
        key: `stem:${g.key}`,
        d: `M ${MOUTH.x} ${MOUTH.y} C ${MOUTH.x} ${MOUTH.y - 8}, ${s.x} ${s.y + 16}, ${s.x} ${s.y + 7}`,
        color: "#4b4980",
        dashed: false,
        opacity: 0.55,
        width: 2,
        ingKey: g.key,
      });
    });
    // ingredient -> its tokens / charges
    floaters.forEach((f, i) => {
      if (!f.src) return;
      const from = slotByIng.get(f.src.key);
      if (!from) return;
      const to = tokenSlots[i];
      const charge = f.kind === "strike" || f.kind === "wild";
      const color =
        f.kind === "strike"
          ? STRIKE
          : f.kind === "wild"
            ? COPPER
            : f.summoned
              ? COPPER
              : tokenColor(f.id!);
      edges.push({
        key: `e:${f.uid}`,
        d: `M ${from.x} ${from.y - 7} C ${from.x} ${from.y - 18}, ${to.x} ${to.y + 18}, ${to.x} ${to.y + 6}`,
        color,
        dashed: charge || !!f.summoned || f.kind === "ghost",
        opacity: f.kind === "ghost" ? 0.16 : charge ? 0.4 : 0.5,
        width: 1.4,
        ingKey: f.src.key,
      });
    });
    return { tokenSlots, ingSlots, edges };
  }, [floaters, ingNodes]);

  // ---- strike drag-and-drop ----
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  // ingredient under the pointer (arc node or tray chip) — its tokens and
  // lines light up while everything else dims
  const [hoverIng, setHoverIng] = useState<string | null>(null);
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
    if (avail.strike === 0) setArmed(false);
  }, [avail.strike]);

  // ---- wildcard picker ----
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const openPicker = (e: ReactMouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPicker({ x: r.left + r.width / 2, y: r.bottom + 6 });
  };

  const labelShadow: React.CSSProperties = {
    textShadow: "0 1px 3px rgba(0,0,0,.9), 0 0 12px rgba(0,0,0,.7)",
  };

  return (
    <div className="relative flex h-full flex-col">
      {/* status bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 font-mono text-xs text-text-muted">
        <span className="uppercase tracking-[0.3em] text-text-faint">
          Perfumer&apos;s Bench
        </span>
        <div className="flex items-center gap-3 tabular-nums">
          <span title="frequencies in the brew">
            <span className="text-text">{totalFreq}</span> freq
          </span>
          <span title="unspent strikes" style={{ color: avail.strike ? STRIKE : undefined }}>
            ⊖ {avail.strike}
          </span>
          <span title="unspent wildcards" style={{ color: avail.wild ? COPPER : undefined }}>
            ⊕ {avail.wild}
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

      {/* stage: frequency arc, ingredient arc, connective lines, the vessel */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* the vessel */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 flex h-[40%] items-end justify-center">
          <CauldronVessel active={totalFreq > 0} />
        </div>

        {/* connective lines: cauldron -> ingredients -> their frequencies */}
        <svg
          className="pointer-events-none absolute inset-0 z-[1] h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {layout.edges.map((e) => {
            const linked = hoverIng !== null && e.ingKey === hoverIng;
            const dimmed = hoverIng !== null && !linked;
            return (
              <path
                key={e.key}
                d={e.d}
                fill="none"
                stroke={linked ? "var(--color-accent)" : e.color}
                strokeWidth={linked ? e.width + 0.8 : e.width}
                strokeLinecap="round"
                strokeDasharray={e.dashed ? "4 4" : undefined}
                opacity={dimmed ? e.opacity * 0.25 : linked ? Math.min(1, e.opacity + 0.4) : e.opacity}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        {/* float field */}
        <div className="absolute inset-0 z-10">
          {floaters.length === 0 && (
            <div className="absolute inset-x-0 top-0 flex h-1/2 items-center justify-center px-6 text-center font-mono text-sm text-text-faint">
              add ingredients to conjure their frequencies…
            </div>
          )}

          {/* frequency arc */}
          {floaters.map((f, i) => {
            const slot = layout.tokenSlots[i];
            const ghost = f.kind === "ghost";
            const linked = hoverIng !== null && f.src?.key === hoverIng;
            const dimmed = hoverIng !== null && !linked;
            let inner: React.ReactNode;
            let label: string;
            if (f.kind === "strike") {
              label = "strike";
              inner = (
                <button
                  type="button"
                  onPointerDown={onStrikePointerDown}
                  onPointerMove={onStrikePointerMove}
                  onPointerUp={onStrikePointerUp}
                  onPointerCancel={onStrikePointerCancel}
                  aria-label="Strike — drag onto a frequency to remove it"
                  title={`Strike: drag onto a frequency to remove it${f.src ? ` (granted by ${f.src.name})` : ""}`}
                  className={`grid h-8 w-8 cursor-grab touch-none select-none place-items-center rounded-full border text-sm font-bold active:cursor-grabbing ${
                    armed ? "ring-2 ring-offset-2 ring-offset-bg" : ""
                  }`}
                  style={{
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
            } else if (f.kind === "wild") {
              label = "wildcard";
              inner = (
                <button
                  type="button"
                  onClick={openPicker}
                  aria-label="Wildcard — click to choose a frequency to summon"
                  title={`Wildcard: click to summon any frequency${f.src ? ` (granted by ${f.src.name})` : ""}`}
                  className="grid h-8 w-8 cursor-pointer place-items-center rounded-full border text-sm font-bold"
                  style={{
                    borderColor: COPPER,
                    color: COPPER,
                    background: "#c98a3c1a",
                    boxShadow: `0 0 14px ${COPPER}55`,
                  }}
                >
                  ⊕
                </button>
              );
            } else {
              label = tokenLabel(f.id!);
              inner = (
                <div
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
                      : `${f.id} frequency${f.summoned ? ", summoned — click to dispel" : ""}${
                          f.src ? `, from ${f.src.name}` : ""
                        }`
                  }
                  title={
                    ghost
                      ? `${f.id} — struck out (click to restore)`
                      : f.summoned
                        ? `${f.id} — summoned (click to dispel)`
                        : f.src
                          ? `${f.id} — from ${f.src.name}`
                          : f.id
                  }
                  className={`relative cursor-pointer rounded-full transition-[filter,opacity] ${
                    hoverTarget === f.uid || linked ? "ring-2 ring-offset-2 ring-offset-bg" : ""
                  }`}
                  style={{
                    opacity: ghost ? 0.34 : 1,
                    filter: ghost ? "grayscale(1)" : "none",
                    ...(hoverTarget === f.uid
                      ? ({ ["--tw-ring-color" as string]: STRIKE } as React.CSSProperties)
                      : linked
                        ? ({ ["--tw-ring-color" as string]: "var(--color-accent)" } as React.CSSProperties)
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
            }
            return (
              <div
                key={f.uid}
                className="pf-slot absolute"
                style={{
                  left: `${slot.x}%`,
                  top: `${slot.y}%`,
                  transform: `translate(-50%, -50%) rotate(${slot.angle}deg)`,
                  zIndex: 10 + i,
                }}
              >
                <div
                  className="pf-float flex flex-col items-center gap-1"
                  style={{ ...driftStyle(f.uid), opacity: dimmed ? 0.3 : 1 }}
                >
                  {inner}
                  <span
                    className="pointer-events-none max-w-[84px] text-center font-mono text-[10px] uppercase leading-tight tracking-wide text-text"
                    style={labelShadow}
                  >
                    {label}
                  </span>
                </div>
              </div>
            );
          })}

          {/* ingredient arc */}
          {ingNodes.map((g, i) => {
            const slot = layout.ingSlots[i];
            const linked = hoverIng === g.key;
            const dimmed = hoverIng !== null && !linked;
            return (
              <div
                key={g.key}
                className="pf-slot absolute"
                style={{
                  left: `${slot.x}%`,
                  top: `${slot.y}%`,
                  transform: `translate(-50%, -50%) rotate(${slot.angle}deg)`,
                  zIndex: 60 + i,
                }}
              >
                <div
                  className="pf-float flex flex-col items-center gap-1"
                  style={{ ...driftStyle(`ing:${g.key}`), opacity: dimmed ? 0.35 : 1 }}
                  onMouseEnter={() => setHoverIng(g.key)}
                  onMouseLeave={() => setHoverIng(null)}
                >
                  <div
                    className={`relative rounded-lg ${linked ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""}`}
                    title={`${g.name}${g.count > 1 ? ` ×${g.count}` : ""}`}
                  >
                    <IngredientVisual keyId={g.key} name={g.name} color={g.color} size={44} />
                    {g.count > 1 && (
                      <span className="absolute -right-2 -top-2 rounded-full border border-border bg-surface px-1 font-mono text-[10px] font-bold text-text">
                        ×{g.count}
                      </span>
                    )}
                  </div>
                  <span
                    className="pointer-events-none max-w-[96px] text-center font-mono text-[10.5px] uppercase leading-tight tracking-wide text-text"
                    style={labelShadow}
                  >
                    {g.name}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* the bottled perfume, named on the cauldron itself */}
        {bottled.length > 0 && (
          <div className="pointer-events-none absolute left-1/2 top-[76%] z-20 -translate-x-1/2 -translate-y-1/2 px-4 text-center">
            <div
              className="font-mono text-[11px] uppercase tracking-[0.35em] text-success"
              style={labelShadow}
            >
              ✦ bottled
            </div>
            <div
              className="font-display text-2xl leading-tight text-text"
              style={{
                textShadow:
                  "0 1px 3px rgba(0,0,0,.9), 0 0 22px rgba(111,227,196,.55)",
              }}
            >
              {bottled.join(" · ")}
            </div>
          </div>
        )}
      </div>

      {/* brew tray — manage what's in the pot; hovering a chip lights up its
          node and tokens in the arcs above */}
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
                onMouseEnter={() => setHoverIng(b.key)}
                onMouseLeave={() => setHoverIng(null)}
                onFocus={() => setHoverIng(b.key)}
                onBlur={() => setHoverIng(null)}
                className={`inline-flex items-center gap-1.5 rounded-full border bg-surface py-1 pl-1 pr-1 text-xs transition-colors ${
                  hoverIng === b.key ? "border-accent/60" : "border-border"
                }`}
              >
                <IngredientVisual keyId={b.key} name={b.name} color={b.color} size={22} />
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
