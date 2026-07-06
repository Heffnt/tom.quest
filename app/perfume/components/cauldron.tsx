"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { BrewState, Ingredient } from "../lib/types";
import type { BenchPermissions, BenchSnapshot } from "../lib/bench-types";
import type { BrewableOption } from "../lib/brewable";
import { type BenchHand, ItemIcon } from "../lib/use-hand";
import {
  effectiveTally,
  availableCharges,
  combineFrequencies,
  msFromList,
} from "../lib/engine";
import {
  ALL_FREQUENCIES,
  FUND,
  isNamed,
  isPureKey,
  freqWeight,
  NAMED,
} from "../data/base";
import {
  FrequencySymbol,
  ChargeSymbol,
  STRIKE,
  COPPER,
  namedColor,
  fundColor,
  tokenColor,
} from "../lib/frequencies";
import BrewBar from "./brew-bar";
import OutputShelf from "./output-shelf";

// The name printed under a floating frequency: school for fundamentals, the
// frequency's own name for named frequencies.
function frequencyName(id: string): string {
  return isNamed(id) ? id : (FUND[id]?.school ?? id);
}

export interface CauldronProps {
  snapshot: BenchSnapshot;
  // the engine view of snapshot.pot (BrewOf applied by the orchestrator)
  brew: BrewState;
  permissions: BenchPermissions;
  hand: BenchHand;
  // hovered catalog/inventory row — forwarded to the brew bar ONLY (hover
  // never touches the graph)
  hoverIngredient: Ingredient | null;
  brewOptions: BrewableOption[];
  blockers: string[];
  onBrew: (perfumeKey: string, recipeIndex: number, k: number) => void;
  onTake: (perfumeKey: string, n: number) => void;
  onStrike: (id: string) => void;
  onUnstrike: (id: string) => void;
  onAddWild: (id: string) => void;
  onRemoveWild: (id: string) => void;
  onClear: () => void;
}

// Deterministic [0,1) hash from a string, so a frequency keeps a stable position
// and animation across re-renders (positions are keyed by frequency identity).
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

// src key of the held stack while committed — its splines run to the cursor
const HAND_SRC = "__hand__";

type FloatKind = "freq" | "ghost" | "strike" | "wild";
type Floater = {
  uid: string;
  kind: FloatKind;
  id?: string; // frequency id for freq/ghost
  fromWild?: boolean; // frequency added via a wild ⊕ (undo-able)
  // the ingredient this frequency came from; for wild frequencies and unspent
  // charges it is the ingredient that GRANTED the ⊕/⊖ (charges are spent in
  // brew order, matching how the engine caps plays to charge totals)
  src?: Src;
};

type Slot = { x: number; y: number; angle: number };

// The stage is one coordinate space (percentages of the stage box): the
// derived-frequency arc at the very top, the frequency arc under it, the
// ingredient arc below that, and the vessel at the bottom. MOUTH is where the
// connective lines rise out of the pot.
const MOUTH = { x: 50, y: 78 };

// The topmost fan: frequencies that auto-combined out of the brew. Wraps
// into extra rows (8 per row, stacking downward) when many derive.
function derivedArcSlot(i: number, n: number): Slot {
  const PER_ROW = 8;
  const row = Math.floor(i / PER_ROW);
  const inRow = Math.min(PER_ROW, n - row * PER_ROW);
  const j = i % PER_ROW;
  const centerY = 7 + row * 11;
  if (inRow <= 1) return { x: 50, y: centerY, angle: 0 };
  const STEP = 0.3;
  const MAX_FAN = 1.6;
  const step = Math.min(STEP, MAX_FAN / (inRow - 1));
  const a = (j - (inRow - 1) / 2) * step;
  const RX = 32;
  const RY = 20; // shallow so stacked rows don't collide
  return {
    x: 50 + RX * Math.sin(a),
    y: centerY + RY - RY * Math.cos(a),
    angle: ((a * 180) / Math.PI) * 0.4,
  };
}

// Fan the frequencies into a "hand of cards" arc — sitting closer to the
// ingredient arc below it, so the top of the stage stays free for multiple
// rows of derived frequencies.
function freqArcSlot(i: number, n: number): Slot {
  if (n <= 1) return { x: 50, y: 33, angle: 0 };
  const STEP = 0.27; // ~15.5° between adjacent cards
  const MAX_FAN = 2.25; // ~129° widest total spread
  const step = Math.min(STEP, MAX_FAN / (n - 1));
  const a = (i - (n - 1) / 2) * step; // radians, centered on 0
  const RX = 38; // horizontal radius (% of stage width)
  const RY = 28; // vertical radius (taller -> a more pronounced arc)
  const pivotY = 61; // arc pivots from below, opening upward
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

// Gentle in-place bob, deterministic per floater so it stays stable across renders.
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

type IngNode = Src & { count: number; hypo: number; hypoBy: string[] };

// One settled stack springing from the cursor into its arc slot: mount at the
// cursor offset, then release into place with an overshoot curve.
function SpringFrom({
  dx,
  dy,
  children,
}: {
  dx: number;
  dy: number;
  children: React.ReactNode;
}) {
  const [offset, setOffset] = useState(true);
  useEffect(() => {
    // double rAF: the offset transform must hit the DOM before the release
    let id2 = 0;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => setOffset(false));
    });
    return () => {
      cancelAnimationFrame(id1);
      cancelAnimationFrame(id2);
    };
  }, []);
  return (
    <div
      style={
        offset
          ? { transform: `translate(${dx}px, ${dy}px)`, transition: "none" }
          : {
              transform: "translate(0, 0)",
              transition: "transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)",
            }
      }
    >
      {children}
    </div>
  );
}

export default function Cauldron({
  snapshot,
  brew,
  permissions,
  hand,
  hoverIngredient,
  brewOptions,
  blockers,
  onBrew,
  onTake,
  onStrike,
  onUnstrike,
  onAddWild,
  onRemoveWild,
  onClear,
}: CauldronProps) {
  const eff = useMemo(() => effectiveTally(brew), [brew]);
  const avail = useMemo(() => availableCharges(brew), [brew]);
  const struckMs = useMemo(() => msFromList(brew.strikePlays), [brew.strikePlays]);

  // a committed held stack participates in the arcs (splines to the cursor);
  // an un-committed one is the ghost's business alone
  const held = hand.hand?.committed ? hand.hand : null;

  // One arc node per distinct ingredient in the pot (with a ×n count), plus
  // how many of its copies are hypothetical (beyond stock) and whose.
  const ingNodes = useMemo<IngNode[]>(() => {
    const order: string[] = [];
    const info = new Map<string, IngNode & { by: Set<string> }>();
    for (const ing of brew.ingredients) {
      if (!info.has(ing.key)) {
        order.push(ing.key);
        info.set(ing.key, {
          key: ing.key,
          name: ing.name,
          color: ing.color,
          count: 0,
          hypo: 0,
          hypoBy: [],
          by: new Set(),
        });
      }
      info.get(ing.key)!.count++;
    }
    for (const item of snapshot.pot) {
      if (item.real) continue;
      const g = info.get(item.key);
      if (g) {
        g.hypo++;
        g.by.add(item.contributorName);
      }
    }
    return order.map((k) => {
      const g = info.get(k)!;
      return { key: g.key, name: g.name, color: g.color, count: g.count, hypo: g.hypo, hypoBy: [...g.by] };
    });
  }, [brew.ingredients, snapshot.pot]);

  // the arc renders the pot MINUS the held stack — its copies ride the cursor
  // as a temporary participant ("you take the icon")
  const arcNodes = useMemo<IngNode[]>(() => {
    if (!held) return ingNodes;
    return ingNodes
      .map((g) =>
        g.key === held.itemKey ? { ...g, count: Math.max(0, g.count - held.count) } : g,
      )
      .filter((g) => g.count > 0);
  }, [ingNodes, held]);

  // Build the floaters for the frequency arc: every emitted frequency attributed
  // to the ingredient that contributed it (strikes ghost the LAST instances of
  // a frequency id, mirroring the engine's id-level strikes), then wild
  // frequencies (attributed to the ⊕-granting ingredient), then unspent ⊖/⊕
  // charges (attributed to their granting ingredient; charges are spent in brew order).
  // The LAST held.count copies of the held key attribute to the hand instead.
  const floaters = useMemo<Floater[]>(() => {
    const out: Floater[] = [];
    const instances: Record<string, Src[]> = {};
    const strikeSources: Src[] = [];
    const wildSources: Src[] = [];
    const heldKey = held?.itemKey;
    const heldTotal = heldKey
      ? brew.ingredients.reduce((n, i) => n + (i.key === heldKey ? 1 : 0), 0)
      : 0;
    const heldStart = held ? Math.max(0, heldTotal - held.count) : 0;
    let heldSeen = 0;
    for (const ing of brew.ingredients) {
      let src: Src = { key: ing.key, name: ing.name, color: ing.color };
      if (heldKey && ing.key === heldKey) {
        heldSeen++;
        if (heldSeen > heldStart) src = { key: HAND_SRC, name: ing.name, color: ing.color };
      }
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
      out.push({ uid: `p:${id}:${n}`, kind: "freq", id, fromWild: true, src: wildSources[i] });
    });
    for (let i = brew.strikePlays.length; i < strikeSources.length; i++) {
      out.push({ uid: `s:${i}`, kind: "strike", src: strikeSources[i] });
    }
    for (let i = brew.wildPlays.length; i < wildSources.length; i++) {
      out.push({ uid: `w:${i}`, kind: "wild", src: wildSources[i] });
    }
    return out;
  }, [brew.ingredients, brew.wildPlays, brew.strikePlays, struckMs, held]);

  const combined = useMemo(() => combineFrequencies(eff), [eff]);
  // what the brew counts for recipes: the tally AFTER auto-combination
  const totalFreq = useMemo(
    () => Object.values(combined.tally).reduce((a, b) => a + b, 0),
    [combined],
  );
  // total fundamental weight of the brew (weight is additive under
  // combination, so the combined tally sums the same as the raw one)
  const brewWeight = useMemo(
    () =>
      Object.entries(combined.tally).reduce(
        (sum, [id, n]) => sum + freqWeight(id) * n,
        0,
      ),
    [combined],
  );
  // ingredients in the pot, not counting pure frequencies
  const realIngCount = useMemo(
    () => brew.ingredients.filter((i) => !isPureKey(i.key)).length,
    [brew.ingredients],
  );
  // charges GRANTED by the brew (spent or not) — the ⊖/⊕ readouts only show
  // when the brew actually carries them
  const granted = useMemo(
    () => ({
      strike: avail.strike + brew.strikePlays.length,
      wild: avail.wild + brew.wildPlays.length,
    }),
    [avail, brew.strikePlays, brew.wildPlays],
  );

  // ---- auto-combination: which frequencies fused into which ----
  // Assign each derived frequency's consumed components to concrete floater
  // instances (first available per id, raw before earlier-derived), so the
  // consumed ones gray out and lines can run from them to what they became.
  const derivedLayer = useMemo(() => {
    const { derived } = combined;
    const avail: Record<string, string[]> = {};
    for (const f of floaters) {
      if (f.kind === "freq" && f.id) (avail[f.id] ??= []).push(f.uid);
    }
    const consumedBy = new Map<string, string>(); // floater uid -> derived uid
    const nodes: { uid: string; id: string }[] = [];
    const links: { from: string; to: string; id: string }[] = [];
    const perId: Record<string, number> = {};
    for (const d of derived) {
      const n = (perId[d.id] = (perId[d.id] ?? 0) + 1);
      const duid = `d:${d.id}:${n}`;
      for (const cid of d.consumed) {
        const pool = avail[cid];
        const src = pool && pool.length ? pool.shift() : undefined;
        if (src) {
          consumedBy.set(src, duid);
          links.push({ from: src, to: duid, id: d.id });
        }
      }
      nodes.push({ uid: duid, id: d.id });
      (avail[d.id] ??= []).push(duid); // a derived frequency can chain upward
    }
    return { consumedBy, nodes, links };
  }, [combined, floaters]);

  // ---- the held stack's stage position (percent space) ----
  const stageRef = useRef<HTMLDivElement | null>(null);
  const handSlot = useMemo<Slot | null>(() => {
    if (!held) return null;
    const r = stageRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return null;
    return {
      x: Math.min(100, Math.max(0, ((held.x - r.left) / r.width) * 100)),
      y: Math.min(100, Math.max(0, ((held.y - r.top) / r.height) * 100)),
      angle: 0,
    };
  }, [held]);

  // ---- layout: slots for all three arcs + the connective lines ----
  const layout = useMemo(() => {
    const tokenSlots = floaters.map((_, i) => freqArcSlot(i, floaters.length));
    const ingSlots = arcNodes.map((_, i) => ingArcSlot(i, arcNodes.length));
    const derivedSlots = derivedLayer.nodes.map((_, i) =>
      derivedArcSlot(i, derivedLayer.nodes.length),
    );
    const slotByIng = new Map(arcNodes.map((g, i) => [g.key, ingSlots[i]]));
    if (handSlot) slotByIng.set(HAND_SRC, handSlot);
    const slotByUid = new Map<string, Slot>();
    floaters.forEach((f, i) => slotByUid.set(f.uid, tokenSlots[i]));
    derivedLayer.nodes.forEach((n, i) => slotByUid.set(n.uid, derivedSlots[i]));
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
    // stems: cauldron mouth -> each ingredient (the held stack included —
    // its stem chases the cursor)
    arcNodes.forEach((g, i) => {
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
    if (handSlot) {
      edges.push({
        key: "stem:hand",
        d: `M ${MOUTH.x} ${MOUTH.y} C ${MOUTH.x} ${MOUTH.y - 8}, ${handSlot.x} ${handSlot.y + 16}, ${handSlot.x} ${handSlot.y + 7}`,
        color: "#4b4980",
        dashed: false,
        opacity: 0.55,
        width: 2,
        ingKey: HAND_SRC,
      });
    }
    // ingredient -> its frequencies / charges
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
            : f.fromWild
              ? COPPER
              : tokenColor(f.id!);
      edges.push({
        key: `e:${f.uid}`,
        d: `M ${from.x} ${from.y - 7} C ${from.x} ${from.y - 18}, ${to.x} ${to.y + 18}, ${to.x} ${to.y + 6}`,
        color,
        dashed: charge || !!f.fromWild || f.kind === "ghost",
        opacity: f.kind === "ghost" ? 0.16 : charge ? 0.4 : 0.5,
        width: 1.4,
        ingKey: f.src.key,
      });
    });
    // consumed frequency -> the derived frequency it combined into
    for (const link of derivedLayer.links) {
      const from = slotByUid.get(link.from);
      const to = slotByUid.get(link.to);
      if (!from || !to) continue;
      edges.push({
        key: `d:${link.from}->${link.to}`,
        d: `M ${from.x} ${from.y - 6} C ${from.x} ${from.y - 14}, ${to.x} ${to.y + 14}, ${to.x} ${to.y + 6}`,
        color: tokenColor(link.id),
        dashed: false,
        opacity: 0.55,
        width: 1.4,
      });
    }
    return { tokenSlots, ingSlots, derivedSlots, edges };
  }, [floaters, arcNodes, derivedLayer, handSlot]);

  // ---- settle spring: the icon flies from the cursor into its slot ----
  const [spring, setSpring] = useState<{ key: string; seq: number; dx: number; dy: number } | null>(null);
  const layoutRef = useRef<{ nodes: IngNode[]; slots: Slot[] }>({ nodes: [], slots: [] });
  layoutRef.current = { nodes: arcNodes, slots: layout.ingSlots };
  const settleFx = hand.settleFx;
  useEffect(() => {
    if (!settleFx) return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const { nodes, slots } = layoutRef.current;
    const i = nodes.findIndex((g) => g.key === settleFx.itemKey);
    if (i === -1) return;
    const sx = rect.left + (slots[i].x / 100) * rect.width;
    const sy = rect.top + (slots[i].y / 100) * rect.height;
    setSpring({ key: settleFx.itemKey, seq: settleFx.seq, dx: settleFx.x - sx, dy: settleFx.y - sy });
    // the spring is one-shot: drop it so later arc reflows don't replay it
    const t = setTimeout(() => setSpring(null), 700);
    return () => clearTimeout(t);
  }, [settleFx]);

  // ---- strike drag-and-drop ----
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  // ingredient under the pointer (arc node) — its frequencies and lines light
  // up while everything else dims
  const [hoverIng, setHoverIng] = useState<string | null>(null);
  const dragInfo = useRef<{ moved: boolean; startX: number; startY: number }>({
    moved: false,
    startX: 0,
    startY: 0,
  });

  const hitTokenAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    const t = el?.closest?.("[data-drop-freq]");
    return t ? t.getAttribute("data-drop-freq") : null;
  };

  const onStrikePointerDown = (e: ReactPointerEvent) => {
    if (!permissions.moveItems) return;
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
    if (!f.id || !permissions.moveItems) return;
    // A wild frequency is dispelled (refunds the ⊕), never struck — striking it
    // would waste a ⊖ since the engine applies strikes before wilds.
    if (f.fromWild) {
      onRemoveWild(f.id);
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
    if (!permissions.moveItems) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPicker({ x: r.left + r.width / 2, y: r.bottom + 6 });
  };

  const hasOutput = useMemo(
    () => Object.values(snapshot.outputTray).some((n) => n > 0),
    [snapshot.outputTray],
  );

  const labelShadow: React.CSSProperties = {
    textShadow: "0 1px 3px rgba(0,0,0,.9), 0 0 12px rgba(0,0,0,.7)",
  };

  return (
    <div data-cauldron-drop="" className="relative flex h-full flex-col">
      {/* status bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 font-mono text-xs text-text-muted">
        <span className="uppercase tracking-[0.3em] text-text-faint">
          Perfumer&apos;s Bench
        </span>
        <div className="flex items-center gap-3 tabular-nums">
          <span title="frequencies in the brew (after combination)">
            <span className="text-text">{totalFreq}</span> freq
          </span>
          <span title="total fundamental weight of the brew">
            w <span className="text-text">{brewWeight}</span>
          </span>
          <span title="ingredients in the pot (pure frequencies not counted)">
            <span className="text-text">{realIngCount}</span> ing
          </span>
          {granted.strike > 0 && (
            <span title="unspent strikes" style={{ color: STRIKE }}>
              ⊖ {avail.strike}
            </span>
          )}
          {granted.wild > 0 && (
            <span title="unspent wildcards" style={{ color: COPPER }}>
              ⊕ {avail.wild}
            </span>
          )}
          <button
            type="button"
            onClick={onClear}
            disabled={brew.ingredients.length === 0 || !permissions.clearPot}
            aria-label="Empty the cauldron"
            title={
              permissions.clearPot
                ? "Empty the cauldron"
                : "You may not clear this pot"
            }
            className="grid h-7 w-7 place-items-center rounded-md border border-border text-text-muted transition-colors duration-150 hover:border-error hover:text-error disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text-muted"
          >
            <svg viewBox="0 0 16 16" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M2.5 4h11M6.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4M4 4l.8 9a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9L12 4M6.5 7v4M9.5 7v4" />
            </svg>
          </button>
        </div>
      </div>

      {/* stage: frequency arc, ingredient arc, connective lines, the vessel.
          data-pf-surface: presence cursors travel in this box's 0-100 space */}
      <div
        ref={stageRef}
        data-pf-surface="stage"
        className="relative min-h-0 flex-1 overflow-hidden"
      >
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
                  title={`Strike: drag onto a frequency to remove it${f.src && f.src.key !== HAND_SRC ? ` (granted by ${f.src.name})` : ""}`}
                  className={`cursor-grab touch-none select-none rounded-full active:cursor-grabbing ${
                    armed ? "ring-2 ring-offset-2 ring-offset-bg" : ""
                  }`}
                  style={{
                    boxShadow: `0 0 14px ${STRIKE}55`,
                    borderRadius: "50%",
                    ...(armed ? ({ ["--tw-ring-color" as string]: STRIKE } as React.CSSProperties) : {}),
                  }}
                >
                  <ChargeSymbol kind="strike" size={44} />
                </button>
              );
            } else if (f.kind === "wild") {
              label = "wildcard";
              inner = (
                <button
                  type="button"
                  onClick={openPicker}
                  aria-label="Wild — click to choose a frequency to add"
                  title={`Wild: click to add any frequency${f.src && f.src.key !== HAND_SRC ? ` (granted by ${f.src.name})` : ""}`}
                  className="cursor-pointer rounded-full"
                  style={{ boxShadow: `0 0 14px ${COPPER}55`, borderRadius: "50%" }}
                >
                  <ChargeSymbol kind="wild" size={44} />
                </button>
              );
            } else {
              label = frequencyName(f.id!);
              // consumed by an auto-combination — grayed out; it no longer
              // counts toward recipes, only the derived frequency above does
              const consumedInto = derivedLayer.consumedBy.get(f.uid);
              const consumedId = consumedInto ? consumedInto.split(":")[1] : null;
              inner = (
                <div
                  {...(!ghost && !f.fromWild ? { "data-drop-freq": f.uid } : {})}
                  onClick={() => {
                    if (!permissions.moveItems) return;
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
                      if (!permissions.moveItems) return;
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
                      : `${f.id} frequency${f.fromWild ? ", wild — click to dispel" : ""}${
                          f.src && f.src.key !== HAND_SRC ? `, from ${f.src.name}` : ""
                        }${consumedId ? `, combined into ${consumedId}` : ""}`
                  }
                  title={
                    ghost
                      ? `${f.id} — struck out (click to restore)`
                      : consumedId
                        ? `${f.id} — combined into ${consumedId}`
                        : f.fromWild
                          ? `${f.id} — wild (click to dispel)`
                          : f.src && f.src.key !== HAND_SRC
                            ? `${f.id} — from ${f.src.name}`
                            : f.id
                  }
                  className={`relative cursor-pointer rounded-full transition-[filter,opacity] ${
                    hoverTarget === f.uid || linked ? "ring-2 ring-offset-2 ring-offset-bg" : ""
                  }`}
                  style={{
                    opacity: ghost ? 0.34 : consumedId ? 0.45 : 1,
                    filter: ghost ? "grayscale(1)" : consumedId ? "grayscale(0.8)" : "none",
                    ...(hoverTarget === f.uid
                      ? ({ ["--tw-ring-color" as string]: STRIKE } as React.CSSProperties)
                      : linked
                        ? ({ ["--tw-ring-color" as string]: "var(--color-accent)" } as React.CSSProperties)
                        : {}),
                  }}
                >
                  <FrequencySymbol id={f.id!} size={44} />
                  {f.fromWild && (
                    <span
                      className="absolute -right-1 -top-1 grid h-3.5 w-3.5 place-items-center rounded-full text-[8px] font-bold"
                      style={{ background: COPPER, color: "#14132B" }}
                    >
                      +
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
                data-testid="freq-float"
                data-kind={f.kind}
                data-freq={f.id}
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

          {/* ingredient arc — every node speaks the hand grammar: left picks
              up from the brew, right (empty hand) returns one, shift-click
              sends one home, press-drag carries one */}
          {arcNodes.map((g, i) => {
            const slot = layout.ingSlots[i];
            const linked = hoverIng === g.key;
            const dimmed = hoverIng !== null && !linked;
            const hypothetical = g.hypo > 0;
            const title = hypothetical
              ? `${g.name} ×${g.count} — ${g.hypo} hypothetical (${g.hypoBy.join(", ")} past stock); hypotheticals block brewing`
              : `${g.name}${g.count > 1 ? ` ×${g.count}` : ""} — click to pick up`;
            const node = (
              <>
                <div
                  role="button"
                  tabIndex={0}
                  data-testid="arc-ingredient"
                  data-item-key={g.key}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      hand.moveHome(g.key, 1);
                      return;
                    }
                    hand.pickUp(g.key, "brew", g.count);
                  }}
                  onContextMenu={(e) => {
                    // holding: the hand's own listener returns one (and eats
                    // the menu); empty hand: one home, per the grammar
                    if (hand.hand) return;
                    e.preventDefault();
                    hand.moveHome(g.key, 1);
                  }}
                  onPointerDown={(e) => hand.beginPress(e, g.key, "brew", g.count)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      hand.pickUp(g.key, "brew", g.count);
                    }
                  }}
                  onDragStart={(e) => e.preventDefault()}
                  aria-label={`${g.name} ×${g.count} in the brew — click to pick up, right-click to return one, shift-click to send one home`}
                  title={title}
                  className={`relative cursor-grab touch-none rounded-lg ${
                    linked
                      ? "ring-2 ring-accent ring-offset-2 ring-offset-bg"
                      : hypothetical
                        ? "outline-dashed outline-2 outline-offset-2 outline-amber-400/80"
                        : ""
                  }`}
                >
                  <ItemIcon itemKey={g.key} name={g.name} color={g.color} size={56} />
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
              </>
            );
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
                  {spring && spring.key === g.key ? (
                    <SpringFrom key={spring.seq} dx={spring.dx} dy={spring.dy}>
                      {node}
                    </SpringFrom>
                  ) : (
                    node
                  )}
                </div>
              </div>
            );
          })}

          {/* derived arc — frequencies auto-combined out of the brew; these
              are what count for recipes (their consumed parts gray out below) */}
          {derivedLayer.nodes.map((n, i) => {
            const slot = layout.derivedSlots[i];
            const chained = derivedLayer.consumedBy.get(n.uid);
            const chainedId = chained ? chained.split(":")[1] : null;
            return (
              <div
                key={n.uid}
                className="pf-slot absolute"
                style={{
                  left: `${slot.x}%`,
                  top: `${slot.y}%`,
                  transform: `translate(-50%, -50%) rotate(${slot.angle}deg)`,
                  zIndex: 40 + i,
                }}
              >
                <div
                  className="pf-float flex flex-col items-center gap-1"
                  style={{
                    ...driftStyle(n.uid),
                    opacity: chainedId ? 0.45 : 1,
                    filter: chainedId ? "grayscale(0.8)" : "none",
                  }}
                >
                  <span
                    title={
                      chainedId
                        ? `${n.id} — combined into ${chainedId}`
                        : `${n.id} — combined from the brew`
                    }
                  >
                    <FrequencySymbol id={n.id} size={44} />
                  </span>
                  <span
                    className="pointer-events-none max-w-[84px] text-center font-mono text-[10px] uppercase leading-tight tracking-wide text-text"
                    style={labelShadow}
                  >
                    {n.id}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* output shelf — brewed phials float over the stage top */}
        {(hasOutput || hand.hand?.from === "output") && (
          <div className="absolute inset-x-0 top-2 z-[70] flex justify-center px-3">
            <OutputShelf
              outputTray={snapshot.outputTray}
              hand={hand}
              canTake={permissions.brewAndTake}
              onTake={onTake}
            />
          </div>
        )}
      </div>

      {/* brew bar — the read-only frequency math (replaces the old tray) */}
      <BrewBar
        brew={brew}
        hoverIngredient={hoverIngredient}
        options={brewOptions}
        blockers={blockers}
        canBrew={blockers.length === 0 && permissions.brewAndTake}
        onBrew={onBrew}
      />

      {/* drag ghost following the cursor */}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: drag.x, top: drag.y, boxShadow: `0 0 18px ${STRIKE}aa` }}
        >
          <ChargeSymbol kind="strike" size={38} />
        </div>
      )}

      {picker && (
        <WildcardPicker
          x={picker.x}
          y={picker.y}
          onPick={(id) => {
            onAddWild(id);
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
      ALL_FREQUENCIES.filter((t) => {
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
      aria-label="Add a wild frequency"
    >
      <div className="border-b border-border p-2">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="wild frequency…"
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
