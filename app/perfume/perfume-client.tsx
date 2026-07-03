"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Ingredient, BrewState } from "./lib/types";
import { baseIngredients, pureIngredients, basePerfumes } from "./data/base";
import {
  baseTally,
  chargeTotals,
  availableCharges,
  evaluate,
} from "./lib/engine";
import Cauldron from "./components/cauldron";
import IngredientPanel from "./components/ingredient-panel";
import IngredientThumb from "./components/ingredient-thumb";
import PerfumePanel from "./components/perfume-panel";

// Side-panel resizing (wide layout only): each panel keeps its width in state,
// clamped so neither the panel nor the cauldron stage can collapse, and
// remembered across visits.
const PANEL_DEFAULTS = { left: 330, right: 420 } as const;
const PANEL_MIN = 240;
const PANEL_MAX = 620;

function clampPanel(w: number): number {
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(w)));
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Clamp manual plays to what the brew can support: no more ⊖/⊕ than charges, and
// a ⊖ may only target a frequency present in the BASE tally (the engine applies
// strikes before summons, so a strike on a summon-only frequency would waste the
// charge — summoned frequencies are dispelled with onUnsummon instead).
function reconcile(ings: Ingredient[], strikePlays: string[], wildPlays: string[]) {
  const totals = chargeTotals(ings);
  const nextWild = wildPlays.slice(0, totals.wild);
  const capped = strikePlays.slice(0, totals.strike);
  const avail: Record<string, number> = { ...baseTally(ings) };
  const nextStrike: string[] = [];
  for (const id of capped) {
    if ((avail[id] || 0) > 0) {
      avail[id]--;
      nextStrike.push(id);
    }
  }
  return { strike: nextStrike, wild: nextWild };
}

export default function PerfumeClient() {
  const ingByKey = useMemo(() => {
    const m = new Map<string, Ingredient>();
    for (const ing of [...baseIngredients, ...pureIngredients]) m.set(ing.key, ing);
    return m;
  }, []);

  // ---- brew state ----
  const [brewKeys, setBrewKeys] = useState<string[]>([]);
  const [strikePlays, setStrikePlays] = useState<string[]>([]);
  const [wildPlays, setWildPlays] = useState<string[]>([]);

  const brewIngredients = useMemo(
    () => brewKeys.map((k) => ingByKey.get(k)).filter((x): x is Ingredient => !!x),
    [brewKeys, ingByKey],
  );

  // keep plays valid as the brew changes
  const sane = useMemo(
    () => reconcile(brewIngredients, strikePlays, wildPlays),
    [brewIngredients, strikePlays, wildPlays],
  );
  useEffect(() => {
    if (!arraysEqual(sane.strike, strikePlays)) setStrikePlays(sane.strike);
    if (!arraysEqual(sane.wild, wildPlays)) setWildPlays(sane.wild);
  }, [sane, strikePlays, wildPlays]);

  const brew = useMemo<BrewState>(
    () => ({ ingredients: brewIngredients, strikePlays: sane.strike, wildPlays: sane.wild }),
    [brewIngredients, sane],
  );

  const avail = useMemo(() => availableCharges(brew), [brew]);
  const base = useMemo(() => baseTally(brewIngredients), [brewIngredients]);

  const brewCounts = useMemo(() => {
    const order: string[] = [];
    const counts = new Map<string, number>();
    for (const k of brewKeys) {
      if (!ingByKey.has(k)) continue;
      if (!counts.has(k)) order.push(k);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return order.map((k) => {
      const ing = ingByKey.get(k)!;
      return { key: k, name: ing.name, color: ing.color, count: counts.get(k)! };
    });
  }, [brewKeys, ingByKey]);

  // ---- brew actions ----
  const addKey = useCallback((key: string) => setBrewKeys((p) => [...p, key]), []);
  const addKeyN = useCallback(
    (key: string, qty = 1) =>
      setBrewKeys((p) => [...p, ...Array<string>(Math.max(1, qty)).fill(key)]),
    [],
  );
  const decKey = useCallback(
    (key: string) =>
      setBrewKeys((p) => {
        const idx = p.lastIndexOf(key);
        if (idx === -1) return p;
        return [...p.slice(0, idx), ...p.slice(idx + 1)];
      }),
    [],
  );
  const removeAllOfKey = useCallback(
    (key: string) => setBrewKeys((p) => p.filter((k) => k !== key)),
    [],
  );
  const clear = useCallback(() => {
    setBrewKeys([]);
    setStrikePlays([]);
    setWildPlays([]);
  }, []);

  const strike = useCallback(
    (id: string) => {
      const alreadyStruck = brew.strikePlays.filter((x) => x === id).length;
      if (avail.strike > 0 && (base[id] ?? 0) - alreadyStruck > 0) {
        setStrikePlays((p) => [...p, id]);
      }
    },
    [avail.strike, base, brew.strikePlays],
  );
  const unstrike = useCallback(
    (id: string) =>
      setStrikePlays((p) => {
        const i = p.indexOf(id);
        return i === -1 ? p : [...p.slice(0, i), ...p.slice(i + 1)];
      }),
    [],
  );
  const summon = useCallback(
    (id: string) => {
      if (avail.wild > 0) setWildPlays((p) => [...p, id]);
    },
    [avail.wild],
  );
  const unsummon = useCallback(
    (id: string) =>
      setWildPlays((p) => {
        const i = p.indexOf(id);
        return i === -1 ? p : [...p.slice(0, i), ...p.slice(i + 1)];
      }),
    [],
  );

  // perfumes the current brew matches exactly — named on the cauldron panel
  const brewed = useMemo(
    () =>
      brew.ingredients.length === 0
        ? []
        : basePerfumes
            .filter((r) => evaluate(brew, r).status === "perfect")
            .map((r) => r.name),
    [brew],
  );

  // per-key counts for the ingredients panel (amber highlight + −/count/+)
  const countsByKey = useMemo(() => {
    const m: Record<string, number> = {};
    for (const k of brewKeys) m[k] = (m[k] ?? 0) + 1;
    return m;
  }, [brewKeys]);

  const panelIngredients = useMemo(
    () => [...baseIngredients, ...pureIngredients],
    [],
  );

  // ---- hover preview + drag-out ----
  // Hovering a panel row previews the brew with that ingredient added; while
  // a row is dragged, the preview follows the pointer INTO the cauldron panel
  // and dropping there commits the add.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ key: string; x: number; y: number; over: boolean } | null>(null);

  const onPreview = useCallback((key: string | null) => setHoverKey(key), []);
  const onBeginDrag = useCallback((key: string, x: number, y: number) => {
    setDrag({ key, x, y, over: false });
  }, []);

  useEffect(() => {
    if (!drag) return;
    document.body.style.userSelect = "none";
    const overCauldron = (x: number, y: number) =>
      !!document.elementFromPoint(x, y)?.closest("[data-cauldron-drop]");
    const onMove = (e: PointerEvent) => {
      setDrag((d) => d && { ...d, x: e.clientX, y: e.clientY, over: overCauldron(e.clientX, e.clientY) });
    };
    const onUp = (e: PointerEvent) => {
      if (overCauldron(e.clientX, e.clientY)) {
        setBrewKeys((p) => [...p, drag.key]);
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // drag.key is stable for the life of one drag; re-binding on every move
    // would thrash listeners
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  // what the cauldron previews: the dragged ingredient while it hovers the
  // cauldron panel, else the hovered row
  const previewKey = drag ? (drag.over ? drag.key : null) : hoverKey;
  const previewIng = previewKey ? (ingByKey.get(previewKey) ?? null) : null;
  const dragIng = drag ? ingByKey.get(drag.key) : null;

  // ---- panel resizing ----
  const [leftW, setLeftW] = useState<number>(PANEL_DEFAULTS.left);
  const [rightW, setRightW] = useState<number>(PANEL_DEFAULTS.right);
  // read the remembered widths after mount so SSR and first client render agree
  useEffect(() => {
    const l = Number(localStorage.getItem("pf:panel:left"));
    const r = Number(localStorage.getItem("pf:panel:right"));
    if (l > 0) setLeftW(clampPanel(l));
    if (r > 0) setRightW(clampPanel(r));
  }, []);

  const resize = useRef<{ side: "left" | "right"; startX: number; startW: number; lastW: number } | null>(null);
  const onResizeDown = useCallback(
    (side: "left" | "right") => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // no active pointer (synthetic events) — moves over the handle still work
      }
      const startW = side === "left" ? leftW : rightW;
      resize.current = { side, startX: e.clientX, startW, lastW: startW };
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    },
    [leftW, rightW],
  );
  const onResizeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = resize.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const w = clampPanel(d.side === "left" ? d.startW + dx : d.startW - dx);
    d.lastW = w;
    (d.side === "left" ? setLeftW : setRightW)(w);
  }, []);
  const onResizeUp = useCallback(() => {
    const d = resize.current;
    if (!d) return;
    resize.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    localStorage.setItem(`pf:panel:${d.side}`, String(d.lastW));
  }, []);
  const resetPanel = useCallback((side: "left" | "right") => {
    (side === "left" ? setLeftW : setRightW)(PANEL_DEFAULTS[side]);
    localStorage.removeItem(`pf:panel:${side}`);
  }, []);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden bg-bg text-text">
      {/* the Byobu bench layout: ingredients panel | cauldron panel | perfume panel
          as three working columns on wide screens; on small screens the page
          scrolls through cauldron panel, then perfume panel, then ingredients
          panel. The page banner is gone — the cauldron panel's own status bar
          carries the Perfumer's Bench name. */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden"
        style={{
          ["--pf-lw" as string]: `${leftW}px`,
          ["--pf-rw" as string]: `${rightW}px`,
        }}
      >
        {/* ingredients panel */}
        <aside className="order-3 flex flex-col overflow-hidden border-t border-border p-3 max-lg:h-[72vh] max-lg:shrink-0 lg:order-1 lg:min-h-0 lg:w-[var(--pf-lw)] lg:flex-none lg:border-t-0">
          <IngredientPanel
            ingredients={panelIngredients}
            brewCounts={countsByKey}
            onAdd={addKey}
            onDec={decKey}
            onRemoveAll={removeAllOfKey}
            onPreview={onPreview}
            onBeginDrag={onBeginDrag}
          />
        </aside>

        {/* drag to resize the ingredients panel (wide layout) */}
        <PanelResizer
          label="Resize the ingredients panel"
          className="lg:order-1"
          onPointerDown={onResizeDown("left")}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onDoubleClick={() => resetPanel("left")}
        />

        {/* cauldron panel */}
        <section
          data-cauldron-drop
          className={`order-1 flex min-w-0 flex-col max-lg:h-[56vh] max-lg:shrink-0 lg:order-2 lg:min-h-0 lg:flex-1 ${
            drag ? (drag.over ? "ring-2 ring-inset ring-accent/60" : "ring-2 ring-inset ring-border") : ""
          }`}
        >
          <Cauldron
            brew={brew}
            brewCounts={brewCounts}
            brewed={brewed}
            preview={previewIng}
            onInc={addKey}
            onDec={decKey}
            onStrike={strike}
            onUnstrike={unstrike}
            onSummon={summon}
            onUnsummon={unsummon}
            onClear={clear}
          />
        </section>

        {/* drag to resize the perfume panel (wide layout) */}
        <PanelResizer
          label="Resize the perfume panel"
          className="lg:order-2"
          onPointerDown={onResizeDown("right")}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onDoubleClick={() => resetPanel("right")}
        />

        {/* perfume panel */}
        <aside className="order-2 flex flex-col overflow-hidden border-t border-border p-3 max-lg:h-[72vh] max-lg:shrink-0 lg:order-3 lg:min-h-0 lg:w-[var(--pf-rw)] lg:flex-none lg:border-t-0">
          <PerfumePanel
            perfumes={basePerfumes}
            brew={brew}
            onAddIngredient={addKeyN}
          />
        </aside>
      </div>

      {/* drag ghost following the pointer */}
      {drag && dragIng && (
        <div
          className="pointer-events-none fixed z-[90] flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border bg-surface py-1 pl-1 pr-2.5 text-xs text-text shadow-xl"
          style={{ left: drag.x, top: drag.y, borderColor: dragIng.color }}
          aria-hidden="true"
        >
          <IngredientThumb
            name={dragIng.name}
            source={dragIng.source}
            color={dragIng.color}
            size={24}
          />
          <span className="max-w-[140px] truncate">{dragIng.name}</span>
        </div>
      )}
    </div>
  );
}

// The draggable divider between panels. It renders the panel border line and
// widens/turns accent on hover; double-click restores the default width. Only
// present in the wide (three-column) layout — the stacked layout has nothing
// to resize.
function PanelResizer({
  label,
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onDoubleClick,
}: {
  label: string;
  className?: string;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label} — drag (double-click to reset)`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      className={`group relative hidden w-2 shrink-0 cursor-col-resize touch-none lg:block ${className ?? ""}`}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-all duration-150 group-hover:w-[3px] group-hover:bg-accent/70 group-active:w-[3px] group-active:bg-accent" />
    </div>
  );
}
