"use client";

// The brew orchestrator (integrator seat — DESIGN.md §§4,6,9). Mode splits into
// two subcomponents because hooks cannot be conditional: LivePerfume mounts the
// Convex brew store, the top bar, presence and the nickname flow; LocalPerfume
// (?local=1, or no NEXT_PUBLIC_CONVEX_URL) mounts the localStorage store and
// nothing networked. Both feed BrewView, which adapts the multi-brew snapshot
// down to the legacy stage components via lib/legacy-adapter until the Phase-4
// stage rebuild consumes BrewSnapshot/BrewActions directly.
//
// Route context: /perfume opens your most recent brew (the party brew for a
// visitor); a deep link /perfume/b/[id] passes brewId and opens that brew.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useAuth } from "../lib/auth";
import type { Ingredient } from "./lib/types";
import type { MemberInfo } from "./lib/brew-types";
import { baseIngredients, basePerfumes, pureIngredients } from "./data/base";
import { brewableOptions } from "./lib/brewable";
import {
  PARTY_KEY,
  itemCounts,
  isIngredientKey,
  itemInfo,
  useConvexBrewStore,
  useLocalBrewStore,
  type BrewStoreResult,
} from "./lib/brew-store";
import {
  useLegacyView,
  type BenchActions,
  type BenchPermissions,
  type BenchSnapshot,
} from "./lib/legacy-adapter";
import {
  colorFor,
  getAnonId,
  loadProfile,
  saveProfile,
  type StoredProfile,
} from "./lib/anon";
import { useHand, HandGhost, type BenchHand } from "./lib/use-hand";
import Cauldron from "./components/cauldron";
import IngredientPanel, { type MemberTab } from "./components/ingredient-panel";
import PerfumePanel from "./components/perfume-panel";
import { ProfilePrompt } from "./components/profile-prompt";
import TopBar from "./components/top-bar";
import SettingsCorner from "./components/settings-corner";
import { drawerHandle, cn } from "./components/ui";
import Cursors from "./components/cursors";

// ── mode split ───────────────────────────────────────────────────────────────

export default function PerfumeClient({ brewId }: { brewId?: string }) {
  // decided after mount so SSR needs neither the query string nor storage
  const [mode, setMode] = useState<"local" | "live" | null>(null);
  useEffect(() => {
    const local =
      new URLSearchParams(window.location.search).get("local") === "1" ||
      !process.env.NEXT_PUBLIC_CONVEX_URL;
    setMode(local ? "local" : "live");
  }, []);
  if (mode === null) return <Shell header={null}>{null}</Shell>;
  return mode === "local" ? <LocalPerfume /> : <LivePerfume brewId={brewId} />;
}

// ── local mode (?local=1): no Convex hooks mounted, no top bar, no presence ──

function LocalPerfume() {
  const store = useLocalBrewStore();
  // local practice: the single practice member is the viewer (the local store's
  // brew owner); no other members exist to tab or gift to.
  return (
    <BrewView store={store} isAnon={false} viewerKey={store.snapshot?.owner ?? null} />
  );
}

// ── live mode ────────────────────────────────────────────────────────────────

function LivePerfume({ brewId }: { brewId?: string }) {
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

  // the nickname gate: the intercepted mutation waits behind the prompt
  const [pendingRun, setPendingRun] = useState<{ run: () => void } | null>(null);
  const onNeedProfile = useCallback((run: () => void) => setPendingRun({ run }), []);

  // which brew is on stage: a deep-link id, or resolved from route defaults
  // (your most recent brew; the party brew for a visitor). `viewKey` is a real
  // brew id or the PARTY_KEY sentinel.
  const [viewKey, setViewKey] = useState<string | null>(brewId ?? null);
  useEffect(() => {
    if (brewId) setViewKey(brewId);
  }, [brewId]);

  const store = useConvexBrewStore(viewKey ?? PARTY_KEY, {
    viewerKey,
    anonId,
    isTom,
    needsProfile,
    onNeedProfile,
    profileName: profile?.name,
    profileColor: profile?.color,
  });

  // default route context: once identity + the brew index resolve, open the
  // viewer's most recent brew, else the party brew (visitors and the empty
  // state land on the party brew).
  useEffect(() => {
    if (brewId || viewKey !== null || !viewerKey || !store.index) return;
    const mine = store.index.groups.find((g) => g.ownerKey === viewerKey);
    const recent = mine?.recent[0]?.brewId;
    setViewKey(recent ?? PARTY_KEY);
  }, [brewId, viewKey, viewerKey, store.index]);

  const presenceName = profile?.name ?? user?.name ?? "Visitor";
  const presenceColor =
    profile?.color ?? (viewerKey ? colorFor(viewerKey) : "#6FE3C4");

  const savedProfile = useCallback(
    (name: string, color: string) => {
      saveProfile({ name, color });
      setProfile({ name, color });
      store.actions.register(name, color);
      const run = pendingRun?.run;
      setPendingRun(null);
      run?.();
    },
    [store.actions, pendingRun],
  );

  // click-to-join (registration): an unnamed anon routes through the nickname
  // prompt first, then registers; a named viewer registers immediately.
  const onJoin = useCallback(() => {
    if (needsProfile) onNeedProfile(() => {});
    else store.actions.register(presenceName, presenceColor);
  }, [needsProfile, onNeedProfile, store.actions, presenceName, presenceColor]);

  return (
    <BrewView
      store={store}
      isAnon={isAnon}
      viewerKey={viewerKey}
      header={
        <TopBar
          index={store.index}
          members={store.members}
          activeKey={store.brewId}
          viewerKey={viewerKey}
          permissions={{
            registered: store.registered,
            nickname: store.permissions.nickname,
            manageBrew: store.permissions.manageBrew,
            isAdmin: store.permissions.isAdmin,
          }}
          actions={{
            onSelect: setViewKey,
            onCreate: async () => {
              const id = await store.actions.createBrew();
              if (id) setViewKey(id);
            },
            onJoin,
            onNickname: store.actions.nicknameBrew,
            onHandoff: store.actions.handoffBrew,
            onCopy: async (srcId) => {
              const id = await store.actions.copyBrew(srcId);
              if (id) setViewKey(id);
            },
            onDelete: (targetId) => {
              store.actions.deleteBrew(targetId);
              // if the open brew was deleted, fall back to the party brew
              if (targetId === store.brewId) setViewKey(PARTY_KEY);
            },
          }}
          settings={
            <SettingsCorner
              registered={store.registered}
              canJoin={!!viewerKey}
              onJoin={onJoin}
              onLeave={store.actions.leave}
            />
          }
        />
      }
      overlays={
        <>
          <Cursors
            brewId={store.brewId === PARTY_KEY ? null : store.brewId}
            identified={!!viewerKey}
            anonId={anonId}
            name={presenceName}
            color={presenceColor}
            hand={null}
            entries={store.presence}
          />
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

// The input-panel member inventory tabs (DESIGN.md §Layout): one per registered
// member, the VIEWER'S OWN FIRST. In local practice mode there are no members —
// synthesize the viewer's own self tab so the "You" inventory tab still renders.
function memberTabsFor(
  members: MemberInfo[],
  viewerKey: string | null,
  viewerName: string,
): MemberTab[] {
  if (members.length === 0) {
    return viewerKey
      ? [{ memberKey: viewerKey, name: viewerName, isSelf: true }]
      : [];
  }
  const tabs: MemberTab[] = members.map((m) => ({
    memberKey: m.memberKey,
    name: m.name,
    isSelf: m.memberKey === viewerKey,
  }));
  // viewer's own first, then the rest as the server ordered them
  tabs.sort((a, b) => (a.isSelf === b.isSelf ? 0 : a.isSelf ? -1 : 1));
  return tabs;
}

// ── the brew view (adapts the multi-brew store to the legacy stage) ──────────

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

type BrewViewProps = {
  store: BrewStoreResult;
  isAnon: boolean;
  /** The viewer's member key (or null before identity resolves) — orders the
   * input-panel member inventory tabs (own first) and scopes gifting. */
  viewerKey: string | null;
  header?: ReactNode;
  overlays?: ReactNode;
};

function BrewView({ store, isAnon, viewerKey, header, overlays }: BrewViewProps) {
  // legacy projection: BrewSnapshot+BrewActions -> the bench prop shapes
  const legacy = useLegacyView(store);
  const snapshot: BenchSnapshot | null = legacy.snapshot;
  const permissions: BenchPermissions = legacy.permissions;
  const actions: BenchActions = legacy.actions;
  const loading = legacy.loading;

  const hand = useBrewHand(snapshot, actions, permissions.moveItems);

  // ---- input-panel member inventory tabs (own first — DESIGN.md §Layout) ----
  const viewerName =
    store.members.find((m) => m.memberKey === viewerKey)?.name ??
    snapshot?.ownerName ??
    "You";
  const memberTabs = useMemo(
    () => memberTabsFor(store.members, viewerKey, viewerName),
    [store.members, viewerKey, viewerName],
  );

  // ---- brew derivation: BenchSnapshot -> engine state + brew-bar inputs ----
  const brew = useMemo(
    () =>
      snapshot ? legacyEngineOf(snapshot) : { ingredients: [], strikePlays: [], wildPlays: [] },
    [snapshot],
  );
  const brewCounts = useMemo(() => itemCounts(snapshot?.pot ?? []), [snapshot]);
  const brewOptions = useMemo(
    () => (brew.ingredients.length ? brewableOptions(brew, basePerfumes) : []),
    [brew],
  );
  const blockers = useMemo(() => {
    const out = hypotheticalBlockersOf(snapshot?.pot ?? []);
    if (!permissions.brewAndTake) out.push("only the brew owner may brew and take");
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

  // ---- narrow-layout drawer state: center stage is always on; the input and
  // perfume-book drawers become edge-tab overlays, only ONE open at a time
  // (DESIGN.md §6). On wide (lg) both are open inline and this state is unused.
  const [openDrawer, setOpenDrawer] = useState<"left" | "right" | null>(null);
  const toggleDrawer = useCallback(
    (side: "left" | "right") =>
      setOpenDrawer((cur) => (cur === side ? null : side)),
    [],
  );
  // Escape closes the open narrow drawer.
  useEffect(() => {
    if (!openDrawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenDrawer(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openDrawer]);

  // The panel bodies, shared by the wide (inline) and narrow (overlay) layouts.
  // Only rendered inside the snapshot-present branch below (falsy otherwise).
  const inputPanel = snapshot && (
    <IngredientPanel
      catalog={PANEL_CATALOG}
      inventory={snapshot.inventory}
      inventoryOf={store.inventoryOf}
      brewCounts={brewCounts}
      ui={snapshot.ui}
      onUI={actions.updateUI}
      hand={hand}
      canMove={permissions.moveItems}
      canEditInventory={permissions.editInventory}
      canGift={store.permissions.gift}
      isAnon={isAnon}
      memberTabs={memberTabs}
      onImport={actions.importInventory}
      onGift={store.actions.giftItem}
      onSelectMemberTab={store.selectMemberTab}
      onHover={onHover}
      onShiftToBrew={onShiftToBrew}
      onUnbrewOne={onUnbrewOne}
    />
  );
  const perfumeBook = snapshot && (
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
  );

  return (
    <Shell header={header}>
      {loading || !snapshot ? (
        <div className="grid flex-1 place-items-center font-mono text-sm text-text-faint">
          lighting the fire…
        </div>
      ) : (
        <div
          className="relative flex min-h-0 flex-1 lg:flex-row lg:overflow-hidden"
          style={{
            ["--pf-lw" as string]: `${leftW}px`,
            ["--pf-rw" as string]: `${rightW}px`,
          }}
        >
          {/* ── input panel: inline drawer (wide) / edge overlay (narrow) ── */}
          <aside
            data-input-drop=""
            aria-label="Input panel"
            className={cn(
              "flex flex-col overflow-hidden border-border bg-bg p-3",
              // wide: an inline resizable drawer flanking the stage, always open
              "lg:relative lg:z-auto lg:min-h-0 lg:w-[var(--pf-lw)] lg:flex-none lg:translate-x-0 lg:border-r lg:shadow-none",
              // narrow: a fixed left overlay, slid off-screen unless open
              "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:w-[86vw] max-lg:max-w-[380px] max-lg:border-r max-lg:shadow-2xl max-lg:transition-transform max-lg:duration-200",
              openDrawer === "left"
                ? "max-lg:translate-x-0"
                : "max-lg:-translate-x-full",
            )}
          >
            {inputPanel}
          </aside>

          {/* drag to resize the input panel (wide layout only) */}
          <PanelResizer
            label="Resize the input panel"
            onPointerDown={onResizeDown("left")}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onDoubleClick={() => resetPanel("left")}
          />

          {/* ── center stage: ALWAYS on (its root carries data-cauldron-drop) ── */}
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
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

          {/* drag to resize the perfume panel (wide layout only) */}
          <PanelResizer
            label="Resize the perfume panel"
            onPointerDown={onResizeDown("right")}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onDoubleClick={() => resetPanel("right")}
          />

          {/* ── perfume book: inline drawer (wide) / edge overlay (narrow) ── */}
          <aside
            aria-label="Perfume book"
            className={cn(
              "flex flex-col overflow-hidden border-border bg-bg p-3",
              "lg:relative lg:z-auto lg:min-h-0 lg:w-[var(--pf-rw)] lg:flex-none lg:translate-x-0 lg:border-l lg:shadow-none",
              "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:w-[86vw] max-lg:max-w-[380px] max-lg:border-l max-lg:shadow-2xl max-lg:transition-transform max-lg:duration-200",
              openDrawer === "right"
                ? "max-lg:translate-x-0"
                : "max-lg:translate-x-full",
            )}
          >
            {perfumeBook}
          </aside>

          {/* narrow-only: scrim + edge-tab handles that open one drawer at a time */}
          {openDrawer && (
            <button
              type="button"
              aria-label="Close panel"
              onClick={() => setOpenDrawer(null)}
              className="fixed inset-0 z-30 bg-black/50 lg:hidden"
            />
          )}
          <DrawerHandle
            side="left"
            label="Inputs"
            open={openDrawer === "left"}
            onClick={() => toggleDrawer("left")}
          />
          <DrawerHandle
            side="right"
            label="Perfumes"
            open={openDrawer === "right"}
            onClick={() => toggleDrawer("right")}
          />
        </div>
      )}

      {/* the held stack at the cursor */}
      <HandGhost hand={hand.hand} itemInfo={itemInfo} />
      {overlays}
    </Shell>
  );
}

// A vertical edge-tab that opens an overlay drawer on the narrow layout. Hidden
// on wide (both drawers are inline and always open there). Pinned to the
// viewport edge and vertically centered; sits above the stage but below an open
// drawer's scrim.
function DrawerHandle({
  side,
  label,
  open,
  onClick,
}: {
  side: "left" | "right";
  label: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={open}
      aria-label={`${open ? "Close" : "Open"} ${label} panel`}
      className={cn(
        drawerHandle,
        "fixed top-1/2 z-40 -translate-y-1/2 lg:hidden",
        side === "left" ? "left-0 rounded-l-none" : "right-0 rounded-r-none",
      )}
    >
      <span className="[writing-mode:vertical-rl]">{label}</span>
    </button>
  );
}

// ── the hand, bound to whichever store is live ───────────────────────────────

function useBrewHand(
  snapshot: BenchSnapshot | null,
  actions: BenchActions,
  canMoveItems: boolean,
): BenchHand {
  const counts = useMemo(() => itemCounts(snapshot?.pot ?? []), [snapshot]);
  return useHand({
    benchActions: actions,
    potCountOf: (itemKey) => counts[itemKey] ?? 0,
    availableOf: (itemKey, from) => {
      if (from === "catalog") return Number.POSITIVE_INFINITY;
      if (from === "brew") return counts[itemKey] ?? 0;
      if (from === "output") return snapshot?.outputTray[itemKey] ?? 0;
      return snapshot?.inventory[sectionOfKey(itemKey)][itemKey] ?? 0;
    },
    canMoveItems,
  });
}

// local re-derivations that avoid importing store internals the view doesn't
// otherwise need
function sectionOfKey(itemKey: string): "ingredients" | "pures" | "perfumes" {
  if (itemKey.startsWith("pure:")) return "pures";
  return basePerfumes.some((p) => p.key === itemKey) ? "perfumes" : "ingredients";
}
function legacyEngineOf(snap: BenchSnapshot) {
  const cat = ING_BY_KEY;
  return {
    ingredients: snap.pot
      .map((p) => cat.get(p.key))
      .filter((i): i is Ingredient => !!i),
    strikePlays: snap.strikePlays,
    wildPlays: snap.wildPlays,
  };
}
function hypotheticalBlockersOf(pot: { key: string; real: boolean }[]): string[] {
  const counts = new Map<string, number>();
  for (const p of pot) if (!p.real) counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
  return [...counts].map(
    ([key, n]) => `${n}× ${itemInfo(key).name} ${n === 1 ? "is" : "are"} hypothetical`,
  );
}

// The page frame: the top bar (live mode) above the three working columns.
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
// present in the wide (three-column) layout.
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
