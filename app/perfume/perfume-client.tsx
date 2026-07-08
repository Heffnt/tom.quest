"use client";

// The brew orchestrator (integrator seat — DESIGN.md §§4,6,9). PerfumeClient
// mounts the Convex brew store, the top bar and presence, and feeds BrewView,
// which mounts the center-stage BrewGraph directly from the multi-brew store
// (BrewSnapshot/BrewActions) alongside the input panel and the perfume panel.
//
// Membership is login-only (DESIGN.md §4): a logged-in user joins by clicking;
// a logged-out visitor renders read-only. Route context: /perfume opens your
// most recent brew (the party brew for a visitor); a deep link /perfume/b/[id]
// passes brewId and opens that brew.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useAuth } from "../lib/auth";
import type { BrewState } from "./lib/types";
import type {
  BrewActions,
  BrewPermissions,
  BrewSnapshot,
  MemberInfo,
} from "./lib/brew-types";
import { baseIngredients, basePerfumes, pureIngredients } from "./data/base";
import { brewableOptions } from "./lib/brewable";
import {
  PARTY_KEY,
  itemCounts,
  isIngredientKey,
  itemInfo,
  brewEngineState,
  hypotheticalBlockers,
  sectionForKey,
  useConvexBrewStore,
  type BrewStoreResult,
} from "./lib/brew-store";
import { useHand, HandGhost, type BrewHand, type HandActions } from "./lib/use-hand";
import { useSound } from "./lib/sound";
import BrewGraph from "./components/brew-graph";
import IngredientPanel, { type MemberTab } from "./components/ingredient-panel";
import PerfumePanel from "./components/perfume-panel";
import TopBar from "./components/top-bar";
import SettingsCorner from "./components/settings-corner";
import { drawerHandle, cn } from "./components/ui";
import Cursors from "./components/cursors";

export default function PerfumeClient({ brewId }: { brewId?: string }) {
  const { user, isTom, loading: authLoading } = useAuth();

  // Membership is login-only (DESIGN.md §4): a logged-in user is keyed by their
  // Convex id; a logged-out visitor has no key and renders read-only.
  const viewerKey = user ? `user:${user._id}` : null;
  const isVisitor = !authLoading && !user;

  // which brew is on stage: a deep-link id, or resolved from route defaults
  // (your most recent brew; the party brew for a visitor). `viewKey` is a real
  // brew id or the PARTY_KEY sentinel.
  const [viewKey, setViewKey] = useState<string | null>(brewId ?? null);
  useEffect(() => {
    if (brewId) setViewKey(brewId);
  }, [brewId]);

  const store = useConvexBrewStore(viewKey ?? PARTY_KEY, { viewerKey, isTom });

  // default route context: once identity + the brew index resolve, open the
  // viewer's most recent brew, else the party brew (visitors and the empty
  // state land on the party brew).
  useEffect(() => {
    if (brewId || viewKey !== null || !viewerKey || !store.index) return;
    const mine = store.index.groups.find((g) => g.ownerKey === viewerKey);
    const recent = mine?.recent[0]?.brewId;
    setViewKey(recent ?? PARTY_KEY);
  }, [brewId, viewKey, viewerKey, store.index]);

  // presence identity: the viewer's registered member row, falling back to the
  // account name / a default color before that row exists.
  const viewerMember = store.members.find((m) => m.memberKey === viewerKey);
  const presenceName = viewerMember?.name ?? user?.name ?? "You";
  const presenceColor = viewerMember?.color ?? "#6FE3C4";

  // click-to-join (registration): a logged-in user joins immediately; name and
  // color default from the account server-side.
  const onJoin = useCallback(() => {
    store.actions.register();
  }, [store.actions]);

  return (
    <BrewView
      store={store}
      isAnon={isVisitor}
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
        <Cursors
          brewId={store.brewId === PARTY_KEY ? null : store.brewId}
          identified={!!viewerKey}
          name={presenceName}
          color={presenceColor}
          hand={null}
          entries={store.presence}
        />
      }
    />
  );
}

// The input-panel member inventory tabs (DESIGN.md §Layout): one per registered
// member, the VIEWER'S OWN FIRST. Before any members are registered, synthesize
// the viewer's own self tab so the "You" inventory tab still renders.
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
  const snapshot: BrewSnapshot | null = store.snapshot;
  const permissions: BrewPermissions = store.permissions;
  const actions: BrewActions = store.actions;
  const loading = store.loading;
  const notFound = store.notFound;

  const hand = useBrewHand(store, snapshot, actions, permissions.moveItems);

  // ---- input-panel member inventory tabs (own first — DESIGN.md §Layout) ----
  const viewerName =
    store.members.find((m) => m.memberKey === viewerKey)?.name ??
    snapshot?.ownerName ??
    "You";
  const memberTabs = useMemo(
    () => memberTabsFor(store.members, viewerKey, viewerName),
    [store.members, viewerKey, viewerName],
  );

  // ---- brew derivation: BrewSnapshot -> engine state + brew options ----
  const brew = useMemo<BrewState>(
    () =>
      snapshot ? brewEngineState(snapshot) : { ingredients: [], strikePlays: [], wildPlays: [] },
    [snapshot],
  );
  const brewCounts = useMemo(() => itemCounts(snapshot?.items ?? []), [snapshot]);
  const brewOptions = useMemo(
    () => (brew.ingredients.length ? brewableOptions(brew, basePerfumes) : []),
    [brew],
  );
  const blockers = useMemo(() => {
    const out = hypotheticalBlockers(snapshot?.items ?? []);
    if (!permissions.brewAndTake) out.push("only the brew owner may brew and take");
    return out;
  }, [snapshot, permissions.brewAndTake]);

  // ---- the brew's shareable deep link (DESIGN.md §4) ----
  const deepLink = useMemo(() => {
    if (!store.brewId || store.brewId === PARTY_KEY) return null;
    if (typeof window === "undefined") return null;
    return `${window.location.origin}/perfume/b/${store.brewId}`;
  }, [store.brewId]);

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

  // ---- gift: the drop plays the 'gift' cue (DESIGN.md §6; mute honoured by
  // useSound), then delegates to the store. Gifting is instant/permanent, so the
  // cue fires on the drop gesture — the same moment brew/take play theirs.
  const sound = useSound();
  const onGift = useCallback(
    (toMemberKey: string, itemKey: string, n: number) => {
      sound.play("gift");
      actions.giftItem(toMemberKey, itemKey, n);
    },
    [sound, actions],
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
  // perfume-panel drawers become edge-tab overlays, only ONE open at a time
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
      inventory={store.ownInventory}
      inventoryOf={store.inventoryOf}
      brewCounts={brewCounts}
      ui={snapshot.ui}
      onUI={actions.updateUI}
      hand={hand}
      canMove={permissions.moveItems}
      canEditInventory={permissions.fillReturn}
      canGift={store.permissions.gift}
      isAnon={isAnon}
      memberTabs={memberTabs}
      members={store.members}
      onImport={actions.importInventory}
      onGift={onGift}
      onSelectMemberTab={store.selectMemberTab}
      onShiftToBrew={onShiftToBrew}
      onUnbrewOne={onUnbrewOne}
    />
  );
  const perfumePanel = snapshot && (
    <PerfumePanel
      perfumes={basePerfumes}
      brew={brew}
      ui={snapshot.ui}
      onUI={actions.updateUI}
      pinned={snapshot.pinned}
      onPin={actions.pinPerfume}
      canPin={permissions.pin}
      hand={hand}
      canMove={permissions.moveItems}
      brewCounts={brewCounts}
      onShiftToBrew={onShiftToBrew}
    />
  );

  return (
    <Shell header={header}>
      {notFound ? (
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div className="flex flex-col items-center gap-3">
            <p className="font-display text-lg text-text">This brew could not be found.</p>
            <p className="font-mono text-xs text-text-faint">
              The link may be mistyped, or the brew was deleted.
            </p>
            <a
              href="/perfume"
              className="rounded-full border border-accent/60 bg-accent/10 px-4 py-1.5 font-mono text-xs uppercase tracking-wider text-accent transition-colors duration-150 hover:bg-accent/20"
            >
              Back to the cauldron
            </a>
          </div>
        </div>
      ) : loading || !snapshot ? (
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

          {/* ── center stage: ALWAYS on (its root carries data-brew-graph) ── */}
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <BrewGraph
              snapshot={snapshot}
              permissions={permissions}
              actions={actions}
              hand={hand}
              undo={store.undo}
              brewOptions={brewOptions}
              blockers={blockers}
              deepLink={deepLink}
              members={store.members}
              onNickname={
                store.brewId && store.brewId !== PARTY_KEY
                  ? (nickname) => actions.nicknameBrew(store.brewId!, nickname)
                  : undefined
              }
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

          {/* ── perfume panel: inline drawer (wide) / edge overlay (narrow) ── */}
          <aside
            aria-label="Perfume panel"
            className={cn(
              "flex flex-col overflow-hidden border-border bg-bg p-3",
              "lg:relative lg:z-auto lg:min-h-0 lg:w-[var(--pf-rw)] lg:flex-none lg:translate-x-0 lg:border-l lg:shadow-none",
              "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:w-[86vw] max-lg:max-w-[380px] max-lg:border-l max-lg:shadow-2xl max-lg:transition-transform max-lg:duration-200",
              openDrawer === "right"
                ? "max-lg:translate-x-0"
                : "max-lg:translate-x-full",
            )}
          >
            {perfumePanel}
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

// ── the hand, bound to the store ─────────────────────────────────────────────
// The hand drives the WHERE moves (moveToBrew / moveToInventory) and — for a
// perfume carried off the cauldron onto the input panel — a take. The store's
// takeOutput is per-instance, so the hand's key-based take resolves the oldest
// matching output instance for that perfume key.

function useBrewHand(
  store: BrewStoreResult,
  snapshot: BrewSnapshot | null,
  actions: BrewActions,
  canMoveItems: boolean,
): BrewHand {
  const counts = useMemo(() => itemCounts(snapshot?.items ?? []), [snapshot]);
  const outputs = useMemo(() => snapshot?.outputs ?? [], [snapshot]);
  const handActions = useMemo<HandActions>(
    () => ({
      moveToBrew: actions.moveToBrew,
      moveToInventory: actions.moveToInventory,
      takeOutput: (perfumeKey: string, n: number) => {
        let remaining = n;
        for (const o of outputs) {
          if (remaining <= 0) break;
          if (o.perfumeId !== perfumeKey) continue;
          const takeN = Math.min(remaining, o.count);
          for (let i = 0; i < takeN; i++) actions.takeOutput(o.instanceId);
          remaining -= takeN;
        }
      },
    }),
    [actions, outputs],
  );
  return useHand({
    brewActions: handActions,
    brewCountOf: (itemKey) => counts[itemKey] ?? 0,
    availableOf: (itemKey, from) => {
      if (from === "catalog") return Number.POSITIVE_INFINITY;
      if (from === "brew") return counts[itemKey] ?? 0;
      if (from === "output") {
        return outputs
          .filter((o) => o.perfumeId === itemKey)
          .reduce((s, o) => s + o.count, 0);
      }
      return store.ownInventory[sectionForKey(itemKey)][itemKey] ?? 0;
    },
    canMoveItems,
  });
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
