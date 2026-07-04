"use client";

// The bench orchestrator (integrator seat — DESIGN.md "The model", "Live
// layer", "Local mode"). Mode splits into two subcomponents because hooks
// cannot be conditional: LivePerfume mounts the Convex store, tabs, presence
// and the nickname flow; LocalPerfume (?local=1, or no NEXT_PUBLIC_CONVEX_URL)
// mounts the localStorage store and nothing networked. Both feed the same
// BenchView, which wires the three panels, the hand and the brew math.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "../lib/auth";
import type { Ingredient } from "./lib/types";
import type {
  BenchActions,
  BenchPermissions,
  BenchSnapshot,
} from "./lib/bench-types";
import { baseIngredients, basePerfumes, pureIngredients } from "./data/base";
import { brewableOptions } from "./lib/brewable";
import {
  PARTY_KEY,
  brewOf,
  hypotheticalBlockers,
  isIngredientKey,
  itemInfo,
  potCounts,
  sectionForKey,
  useConvexBenchStore,
  useLocalBenchStore,
} from "./lib/bench-store";
import {
  colorFor,
  getAnonId,
  loadProfile,
  saveProfile,
  type StoredProfile,
} from "./lib/anon";
import { useHand, HandGhost, type BenchHand } from "./lib/use-hand";
import Cauldron from "./components/cauldron";
import IngredientPanel from "./components/ingredient-panel";
import PerfumePanel from "./components/perfume-panel";
import Tabs, { ProfilePrompt, type BenchTab } from "./components/tabs";
import Cursors from "./components/cursors";

// ── mode split ───────────────────────────────────────────────────────────────

export default function PerfumeClient() {
  // decided after mount so SSR needs neither the query string nor storage
  const [mode, setMode] = useState<"local" | "live" | null>(null);
  useEffect(() => {
    const local =
      new URLSearchParams(window.location.search).get("local") === "1" ||
      !process.env.NEXT_PUBLIC_CONVEX_URL;
    setMode(local ? "local" : "live");
  }, []);
  if (mode === null) return <Shell header={null}>{null}</Shell>;
  return mode === "local" ? <LocalPerfume /> : <LivePerfume />;
}

// ── local mode (?local=1): no Convex hooks mounted, no tabs, no presence ─────

function LocalPerfume() {
  const store = useLocalBenchStore();
  const hand = useBenchHand(store.snapshot, store.actions, store.permissions.moveItems);
  return (
    <BenchView
      snapshot={store.snapshot}
      permissions={store.permissions}
      actions={store.actions}
      loading={store.loading}
      hand={hand}
      isAnon={false}
      members={[]}
    />
  );
}

// ── live mode ────────────────────────────────────────────────────────────────

function LivePerfume() {
  const { user, isTom, loading: authLoading } = useAuth();

  // anonymous identity: minted (and persisted) once auth resolves logged-out
  const [anonId, setAnonId] = useState<string | null>(null);
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  useEffect(() => {
    setProfile(loadProfile());
  }, []);
  useEffect(() => {
    if (!authLoading && !user) setAnonId(getAnonId());
  }, [authLoading, user]);

  const viewerKey = user ? `user:${user._id}` : anonId;
  const isAnon = !authLoading && !user;
  const needsProfile = isAnon && profile === null;

  // which bench is on stage: your own once known, else the party pot
  const [viewKey, setViewKey] = useState<string | null>(null);
  useEffect(() => {
    if (viewKey === null && viewerKey) setViewKey(user ? viewerKey : PARTY_KEY);
  }, [viewKey, viewerKey, user]);

  // the nickname gate: the intercepted mutation waits behind the prompt
  const [pendingRun, setPendingRun] = useState<{ run: () => void } | null>(null);
  const onNeedProfile = useCallback((run: () => void) => setPendingRun({ run }), []);

  const store = useConvexBenchStore(viewKey ?? PARTY_KEY, {
    viewerKey,
    anonId,
    isTom,
    needsProfile,
    onNeedProfile,
    profileName: profile?.name,
    profileColor: profile?.color,
  });

  const hand = useBenchHand(store.snapshot, store.actions, store.permissions.moveItems);

  // tabs: party first (from the server), plus a synthetic own tab until
  // ensureBench persists the real one
  const benchList = useQuery(api.perfume.listBenches);
  const tabs = useMemo<BenchTab[]>(() => {
    const list: BenchTab[] = benchList
      ? [...benchList]
      : [{ benchKey: PARTY_KEY, ownerName: "Party", color: "#C98A3C" }];
    if (user) {
      const own = `user:${user._id}`;
      if (!list.some((b) => b.benchKey === own)) {
        list.push({ benchKey: own, ownerName: user.name, color: colorFor(own) });
      }
    }
    return list;
  }, [benchList, user]);

  const members = useMemo(
    () =>
      tabs
        .filter((b) => b.benchKey !== PARTY_KEY && b.benchKey !== viewerKey)
        .map((b) => ({ benchKey: b.benchKey, name: b.ownerName })),
    [tabs, viewerKey],
  );

  const ownTab = tabs.find((b) => b.benchKey === viewerKey);
  const presenceName = profile?.name ?? user?.name ?? "Visitor";
  const presenceColor =
    ownTab?.color ?? profile?.color ?? (viewerKey ? colorFor(viewerKey) : "#6FE3C4");

  const savedProfile = useCallback(
    (name: string, color: string) => {
      saveProfile({ name, color });
      setProfile({ name, color });
      store.actions.setProfile({ name, color });
      const run = pendingRun?.run;
      setPendingRun(null);
      run?.();
    },
    [store.actions, pendingRun],
  );

  return (
    <BenchView
      snapshot={store.snapshot}
      permissions={store.permissions}
      actions={store.actions}
      loading={store.loading || viewKey === null}
      hand={hand}
      isAnon={isAnon}
      members={members}
      header={
        <Tabs
          tabs={tabs}
          activeKey={viewKey ?? PARTY_KEY}
          ownKey={viewerKey}
          onSelect={setViewKey}
          onColor={(color) => store.actions.setProfile({ color })}
        />
      }
      overlays={
        <>
          {viewKey && (
            <Cursors
              benchKey={viewKey}
              identified={!!viewerKey}
              anonId={anonId}
              name={presenceName}
              color={presenceColor}
              hand={hand.hand}
            />
          )}
          {pendingRun && (
            <ProfilePrompt
              defaultName=""
              defaultColor={presenceColor}
              onSave={savedProfile}
              onClose={() => setPendingRun(null)}
            />
          )}
        </>
      }
    />
  );
}

// ── the hand, bound to whichever store is live ───────────────────────────────

function useBenchHand(
  snapshot: BenchSnapshot | null,
  actions: BenchActions,
  canMoveItems: boolean,
): BenchHand {
  const counts = useMemo(() => potCounts(snapshot?.pot ?? []), [snapshot]);
  return useHand({
    benchActions: actions,
    potCountOf: (itemKey) => counts[itemKey] ?? 0,
    availableOf: (itemKey, from) => {
      if (from === "catalog") return Number.POSITIVE_INFINITY;
      if (from === "brew") return counts[itemKey] ?? 0;
      if (from === "output") return snapshot?.outputTray[itemKey] ?? 0;
      return snapshot?.inventory[sectionForKey(itemKey)][itemKey] ?? 0;
    },
    canMoveItems,
  });
}

// ── the bench itself ─────────────────────────────────────────────────────────

// Side-panel resizing (wide layout only): each panel keeps its width in state,
// clamped so neither the panel nor the cauldron stage can collapse, and
// remembered across visits. The left default fits the WIDEST catalog row with
// nothing truncated; the storage key is versioned so a new default wins over
// stale saved widths.
const PANEL_DEFAULTS = { left: 480, right: 420 } as const;
const PANEL_STORE = "pf:panel2";
const PANEL_MIN = 240;
const PANEL_MAX = 620;

function clampPanel(w: number): number {
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(w)));
}

const ING_BY_KEY = new Map<string, Ingredient>(
  [...baseIngredients, ...pureIngredients].map((i) => [i.key, i]),
);
const PANEL_CATALOG = [...baseIngredients, ...pureIngredients];

type BenchViewProps = {
  snapshot: BenchSnapshot | null;
  permissions: BenchPermissions;
  actions: BenchActions;
  loading: boolean;
  hand: BenchHand;
  isAnon: boolean;
  members: { benchKey: string; name: string }[];
  header?: ReactNode;
  overlays?: ReactNode;
};

function BenchView({
  snapshot,
  permissions,
  actions,
  loading,
  hand,
  isAnon,
  members,
  header,
  overlays,
}: BenchViewProps) {
  // ---- brew derivation: BenchSnapshot -> engine state + brew-bar inputs ----
  const brew = useMemo(
    () =>
      snapshot ? brewOf(snapshot) : { ingredients: [], strikePlays: [], wildPlays: [] },
    [snapshot],
  );
  const brewCounts = useMemo(() => potCounts(snapshot?.pot ?? []), [snapshot]);
  const brewOptions = useMemo(
    () => (brew.ingredients.length ? brewableOptions(brew, basePerfumes) : []),
    [brew],
  );
  const blockers = useMemo(() => {
    const out = hypotheticalBlockers(snapshot?.pot ?? []);
    if (!permissions.brewAndTake) out.push("only the bench owner may brew and take");
    return out;
  }, [snapshot, permissions.brewAndTake]);

  // ---- hover: panels report keys; ONLY the brew bar previews them ----
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const onHover = useCallback((key: string | null) => setHoverKey(key), []);
  const hoverIngredient = hoverKey ? (ING_BY_KEY.get(hoverKey) ?? null) : null;

  // ---- shift-click teleports: direct one-unit moves, no hand involved ----
  const onShiftToBrew = useCallback(
    (itemKey: string) => {
      if (isIngredientKey(itemKey)) actions.moveToBrew(itemKey, 1);
    },
    [actions],
  );
  const onUnbrewOne = useCallback(
    (itemKey: string) => actions.moveToInventory(itemKey, 1),
    [actions],
  );

  // ---- panel resizing ----
  const [leftW, setLeftW] = useState<number>(PANEL_DEFAULTS.left);
  const [rightW, setRightW] = useState<number>(PANEL_DEFAULTS.right);
  // read the remembered widths after mount so SSR and first client render agree
  useEffect(() => {
    const l = Number(localStorage.getItem(`${PANEL_STORE}:left`));
    const r = Number(localStorage.getItem(`${PANEL_STORE}:right`));
    if (l > 0) setLeftW(clampPanel(l));
    if (r > 0) setRightW(clampPanel(r));
  }, []);

  const [resize, setResize] = useState<{
    side: "left" | "right";
    startX: number;
    startW: number;
    lastW: number;
  } | null>(null);
  const onResizeDown = useCallback(
    (side: "left" | "right") => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // no active pointer (synthetic events) — moves over the handle still work
      }
      const startW = side === "left" ? leftW : rightW;
      setResize({ side, startX: e.clientX, startW, lastW: startW });
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    },
    [leftW, rightW],
  );
  const onResizeMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!resize) return;
      const dx = e.clientX - resize.startX;
      const w = clampPanel(resize.side === "left" ? resize.startW + dx : resize.startW - dx);
      setResize({ ...resize, lastW: w });
      (resize.side === "left" ? setLeftW : setRightW)(w);
    },
    [resize],
  );
  const onResizeUp = useCallback(() => {
    if (!resize) return;
    setResize(null);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    localStorage.setItem(`${PANEL_STORE}:${resize.side}`, String(resize.lastW));
  }, [resize]);
  const resetPanel = useCallback((side: "left" | "right") => {
    (side === "left" ? setLeftW : setRightW)(PANEL_DEFAULTS[side]);
    localStorage.removeItem(`${PANEL_STORE}:${side}`);
  }, []);

  return (
    <Shell header={header}>
      {loading || !snapshot ? (
        <div className="grid flex-1 place-items-center font-mono text-sm text-text-faint">
          lighting the fire…
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden"
          style={{
            ["--pf-lw" as string]: `${leftW}px`,
            ["--pf-rw" as string]: `${rightW}px`,
          }}
        >
          {/* input panel — data-input-drop is where output phials settle */}
          <aside
            data-input-drop=""
            className="order-3 flex flex-col overflow-hidden border-t border-border p-3 max-lg:h-[72vh] max-lg:shrink-0 lg:order-1 lg:min-h-0 lg:w-[var(--pf-lw)] lg:flex-none lg:border-t-0"
          >
            <IngredientPanel
              catalog={PANEL_CATALOG}
              inventory={snapshot.inventory}
              brewCounts={brewCounts}
              ui={snapshot.ui}
              onUI={actions.updateUI}
              hand={hand}
              permissions={permissions}
              isAnon={isAnon}
              members={members}
              onImport={actions.importInventory}
              onTransfer={actions.transfer}
              onHover={onHover}
              onShiftToBrew={onShiftToBrew}
              onUnbrewOne={onUnbrewOne}
            />
          </aside>

          {/* drag to resize the input panel (wide layout) */}
          <PanelResizer
            label="Resize the input panel"
            className="lg:order-1"
            onPointerDown={onResizeDown("left")}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onDoubleClick={() => resetPanel("left")}
          />

          {/* cauldron panel (its root carries data-cauldron-drop) */}
          <section className="order-1 flex min-w-0 flex-col max-lg:h-[56vh] max-lg:shrink-0 lg:order-2 lg:min-h-0 lg:flex-1">
            <Cauldron
              snapshot={snapshot}
              brew={brew}
              permissions={permissions}
              hand={hand}
              hoverIngredient={hoverIngredient}
              brewOptions={brewOptions}
              blockers={blockers}
              onBrew={actions.brewPerfume}
              onTake={actions.takeOutput}
              onStrike={actions.playStrike}
              onUnstrike={actions.unplayStrike}
              onAddWild={actions.playWild}
              onRemoveWild={actions.unplayWild}
              onClear={actions.clearPot}
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
              ui={snapshot.ui}
              onUI={actions.updateUI}
              permissions={permissions}
              hand={hand}
              onHover={onHover}
              brewCounts={brewCounts}
              onShiftToBrew={onShiftToBrew}
            />
          </aside>
        </div>
      )}

      {/* the held stack at the cursor */}
      <HandGhost hand={hand.hand} itemInfo={itemInfo} />
      {overlays}
    </Shell>
  );
}

// The page frame: tab strip (live mode) above the three working columns.
function Shell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden bg-bg text-text">
      {header}
      {children}
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
