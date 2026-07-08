"use client";

// The brew graph — the always-on center stage (DESIGN.md §6 "Center stage").
// It RENDERS the layout model (lib/brew-graph-layout.ts); it does not re-derive
// any rule. buildBrewGraph resolves what emits what, what combines, whether a
// strike lands, k for the pinned recipe, and the blend tint — this component
// only draws nodes/edges in the house aesthetic and wires interactions.
//
// Orientation is fixed (layout model): the cauldron node at the bottom, the
// ingredient band above it, the frequency band above that, the combined band at
// the top. Growth is upward. Every node carries an abstract 0..100 stage
// position; this component scales it to the stage box.
//
// Interactions (DESIGN.md §5): items drag between panel and graph via the hand
// (graph item nodes are grab sources; the whole stage is the panel-drop target,
// through the hand's [data-brew-graph] boundary). STRIKE dragging — an unspent
// strike charge is a draggable circle dropped onto a frequency circle to strike
// it (store.playStrike); a struck circle wears a violet cover with an un-strike
// affordance. WILD — a played wild's frequency is chosen from a dropdown
// (store.playWild). Pin ghosts live-update. Outputs stack on the cauldron rim as
// tinted bottles with a take affordance. On completion the BREW action runs the
// ceremony (frequencies drawing down, a liquid flash, a bottle pop) with sound.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { BrewSnapshot, BrewPermissions, BrewActions, UndoState, OutputInstance } from "../lib/brew-types";
import type { BrewableOption } from "../lib/brewable";
import {
  buildBrewGraph,
  blendTint,
  type BrewGraph as BrewGraphModel,
  type FrequencyNode,
  type CombinedNode,
  type ChargeNode,
  type WildNode,
  type ItemNode,
  type GhostFrequencyNode,
  type GhostStrikeNode,
} from "../lib/brew-graph-layout";
import {
  ALL_FREQUENCIES,
  NAMED,
  PERFUME_BY_KEY,
  isNamed,
} from "../data/base";
import {
  FrequencySymbol,
  FrequencyGlyph,
  ChargeSymbol,
  STRIKE,
  COPPER,
  tokenColor,
} from "../lib/frequencies";
import { type BrewHand } from "../lib/use-hand";
import { ItemArt } from "./item-art";
import { PhialGlyph } from "./phial";
import { useSound, prefersReducedMotion } from "../lib/sound";
import { makeNameResolver, provenanceTooltip, type NameResolver } from "../lib/provenance";
import { recipeLabel } from "../lib/recipe-label";
import { btn, cn } from "./ui";
import { mix as mixHex } from "../lib/color";
import { frequencyLabel } from "../lib/frequency-label";
import { ChipLabel } from "./glyphs";
import { CountBadge } from "./badge";
import { Popover } from "./popover";

// ── helpers ──────────────────────────────────────────────────────────────────

function perfumeName(key: string): string {
  return PERFUME_BY_KEY.get(key)?.name ?? key.replace(/^base:/, "");
}

// WHICH recipe a completed/satisfied brew landed on lives in lib/recipe-label
// so the stage and the perfume book (which both name recipes) share ONE
// phrasing (DESIGN.md §1 recipe / §Recipe "the UI shows which recipe").

// The blend tint of a perfume's common recipe — the bottle's glass colour and
// the reference for the cauldron liquid. Reuses the layout model's blendTint
// (the SAME logic the cauldron liquid uses) over the recipe's frequency list.
function perfumeTint(perfumeId: string): string {
  const p = PERFUME_BY_KEY.get(perfumeId);
  if (!p || p.recipes.length === 0) return "#6FE3C4";
  const ms: Record<string, number> = {};
  for (const f of p.recipes[0]) ms[f] = (ms[f] ?? 0) + 1;
  return blendTint(ms);
}

// Deterministic [0,1) hash for stable per-node drift (unchanged house feel).
function hash01(str: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function driftStyle(uid: string): React.CSSProperties {
  const dx = (hash01(uid, 3) - 0.5) * 10;
  const dy = -4 - hash01(uid, 4) * 6;
  const rot = (hash01(uid, 5) - 0.5) * 6;
  const dur = 3.5 + hash01(uid, 6) * 3;
  const delay = -hash01(uid, 7) * 5;
  return {
    ["--pf-dx" as string]: `${dx}px`,
    ["--pf-dy" as string]: `${dy}px`,
    ["--pf-rot" as string]: `${rot}deg`,
    ["--pf-dur" as string]: `${dur}s`,
    ["--pf-delay" as string]: `${delay}s`,
  };
}

// ── props ────────────────────────────────────────────────────────────────────

export interface BrewGraphProps {
  snapshot: BrewSnapshot;
  permissions: BrewPermissions;
  actions: BrewActions;
  hand: BrewHand;
  undo: UndoState;
  /** Perfumes the current tally EXACTLY brews (from lib/brewable) — the Brew
   * action shows the first, with ×k. */
  brewOptions: BrewableOption[];
  /** Why brewing is blocked (hypothetical items / permissions) — the disabled
   * Brew button names them. */
  blockers: string[];
  /** Copy the brew's deep link (/perfume/b/[id]); null when not shareable. */
  deepLink: string | null;
  /** Rename the open brew (any member). */
  onNickname?: (nickname: string) => void;
  /** Members, for resolving output-provenance memberKeys → display names in the
   * cauldron bottle hover tooltip (DESIGN.md §1,§9). */
  members: { memberKey: string; name: string }[];
}

// ── the stage ────────────────────────────────────────────────────────────────

export default function BrewGraph({
  snapshot,
  permissions,
  actions,
  hand,
  undo,
  brewOptions,
  blockers,
  deepLink,
  onNickname,
  members,
}: BrewGraphProps) {
  const sound = useSound();
  const resolveName = useMemo(() => makeNameResolver(members), [members]);

  // The layout model — pure, deterministic; every rule already resolved.
  const graph = useMemo<BrewGraphModel>(
    () =>
      buildBrewGraph({
        items: snapshot.items,
        strikePlays: snapshot.strikePlays,
        wildPlays: snapshot.wildPlays,
        pinned: snapshot.pinned,
      }),
    [snapshot.items, snapshot.strikePlays, snapshot.wildPlays, snapshot.pinned],
  );

  const active = graph.cauldron.tallyCount > 0 || graph.items.length > 0;
  const canMove = permissions.moveItems;

  // ── item counts in the brew (for the hand's grab caps) ──
  const stageRef = useRef<HTMLDivElement | null>(null);

  // ── strike drag: an unspent strike charge dropped onto a frequency circle ──
  const [strikeDrag, setStrikeDrag] = useState<{ x: number; y: number } | null>(null);
  const [strikeHover, setStrikeHover] = useState<string | null>(null); // freq node id under the drag
  const dragInfo = useRef({ moved: false, startX: 0, startY: 0 });

  const hitFreqAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    const t = el?.closest?.("[data-strike-target]");
    return t ? t.getAttribute("data-strike-target") : null;
  };

  const onStrikeDown = (e: ReactPointerEvent) => {
    if (!canMove) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragInfo.current = { moved: false, startX: e.clientX, startY: e.clientY };
    setStrikeDrag({ x: e.clientX, y: e.clientY });
  };
  const onStrikeMove = (e: ReactPointerEvent) => {
    if (!strikeDrag) return;
    const dx = e.clientX - dragInfo.current.startX;
    const dy = e.clientY - dragInfo.current.startY;
    if (Math.hypot(dx, dy) > 5) dragInfo.current.moved = true;
    setStrikeDrag({ x: e.clientX, y: e.clientY });
    setStrikeHover(hitFreqAt(e.clientX, e.clientY));
  };
  const onStrikeUp = (e: ReactPointerEvent) => {
    if (!strikeDrag) return;
    const targetId = hitFreqAt(e.clientX, e.clientY);
    if (dragInfo.current.moved && targetId) {
      const node = graph.frequencies.find((f) => f.id === targetId);
      if (node && !node.struck && !node.consumed) actions.playStrike(node.freq);
    }
    setStrikeDrag(null);
    setStrikeHover(null);
  };

  // ── wild picker ──
  // Opened from an available wild CHARGE (no play yet — choosing plays it) or
  // from an already-played wild NODE (choosing replaces its frequency). `current`
  // is the played wild's frequency to unplay-then-replace, or null for a charge.
  const [picker, setPicker] = useState<{ x: number; y: number; current: string | null } | null>(null);
  const openPickerAt = (el: HTMLElement, current: string | null) => {
    if (!canMove) return;
    const r = el.getBoundingClientRect();
    setPicker({ x: r.left + r.width / 2, y: r.bottom + 6, current });
  };
  const chooseWild = (freq: string) => {
    if (!picker) return;
    // choosing on a played wild replaces its frequency; on a charge it just plays
    if (picker.current) actions.unplayWild(picker.current);
    actions.playWild(freq);
    setPicker(null);
  };

  // ── an available strike charge lit for the click-to-arm fallback (no drag) ──
  const [armed, setArmed] = useState(false);
  const availStrike = graph.charges.filter((c) => c.charge === "strike").length;
  useEffect(() => {
    if (availStrike === 0) setArmed(false);
  }, [availStrike]);
  const onArmedStrike = (node: FrequencyNode) => {
    if (!armed || !canMove || node.struck || node.consumed) return;
    actions.playStrike(node.freq);
    setArmed(false);
  };

  // ── the brewing ceremony ──
  const brewable = brewOptions[0] ?? null;
  const [ceremony, setCeremony] = useState<{ tint: string; k: number; name: string } | null>(null);
  // In LOCAL mode actions.brew flips items hypothetical synchronously, so a
  // second click re-derives non-empty blockers and disables the button. In LIVE
  // mode actions.brew is async (the reactive snapshot lags a server round-trip),
  // so the button stays enabled during the ceremony; gating canBrew on the
  // ceremony makes the "one brew per completion" state machine explicit and
  // stops a fast double-click firing a duplicate (server-rejected) mutation.
  const canBrew =
    brewable !== null && blockers.length === 0 && permissions.brewAndTake && ceremony === null;
  // the ceremony's dismissal timer, cleared on unmount so it never setStates a
  // BrewGraph that has been swapped out mid-ceremony (brew switch / navigation).
  const ceremonyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (ceremonyTimer.current !== null) window.clearTimeout(ceremonyTimer.current);
    },
    [],
  );
  const runBrew = useCallback(() => {
    if (!brewable || ceremony !== null) return;
    const tint = perfumeTint(brewable.perfume.key);
    actions.brew(brewable.perfume.key, brewable.recipeIndex, brewable.k);
    sound.play("brew-complete");
    // the ceremony is a short orchestrated overlay; reduced-motion shortens it
    setCeremony({ tint, k: brewable.k, name: brewable.perfume.name });
    const dur = prefersReducedMotion() ? 350 : 1500;
    if (ceremonyTimer.current !== null) window.clearTimeout(ceremonyTimer.current);
    ceremonyTimer.current = window.setTimeout(() => {
      ceremonyTimer.current = null;
      setCeremony(null);
    }, dur);
  }, [brewable, ceremony, actions, sound]);

  // ── outputs resting on the cauldron rim ──
  const takeOutput = useCallback(
    (instanceId: string) => {
      if (!permissions.brewAndTake) return;
      actions.takeOutput(instanceId);
      sound.play("take");
    },
    [actions, permissions.brewAndTake, sound],
  );

  return (
    // data-brew-graph: the hand's boundary — a stack carried inside commits to
    // the brew (moveToBrew), leaving un-commits it. data-pf-surface: presence
    // cursors travel in this box's 0..100 space.
    <div data-brew-graph="" className="relative flex h-full flex-col">
      <StageHeader
        snapshot={snapshot}
        permissions={permissions}
        undo={undo}
        actions={actions}
        deepLink={deepLink}
        onNickname={onNickname}
        graph={graph}
      />

      <div
        ref={stageRef}
        data-pf-surface="stage"
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        {/* the vessel */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 flex h-[40%] items-end justify-center">
          <CauldronVessel active={active} tint={graph.cauldron.tint} />
        </div>

        {/* connective splines: cauldron -> item -> its frequencies / charges,
            component -> combined, ghost frame -> ghost circle */}
        <GraphEdges graph={graph} ceremony={ceremony !== null} />

        {/* node field */}
        <div className="absolute inset-0 z-10">
          {graph.items.length === 0 && graph.ghostFrequencies.length === 0 && (
            <div className="absolute inset-x-0 top-0 flex h-1/2 items-center justify-center px-6 text-center font-mono text-sm text-text-faint">
              drag ingredients here to conjure their frequencies…
            </div>
          )}

          {/* frequency band: emitted circles */}
          {graph.frequencies.map((f) => (
            <FrequencyChip
              key={f.id}
              node={f}
              canMove={canMove}
              armed={armed}
              strikeHover={strikeHover === f.id}
              ceremony={ceremony !== null}
              onArmedStrike={() => onArmedStrike(f)}
              onUnstrike={() => actions.unplayStrike(f.freq)}
            />
          ))}

          {/* wild nodes (played) — a dropdown chooses the frequency */}
          {graph.wilds.map((w) => (
            <WildChip
              key={w.id}
              node={w}
              canMove={canMove}
              onOpen={(e) => openPickerAt(e.currentTarget as HTMLElement, w.chosenFreq)}
              onDispel={() => w.chosenFreq && actions.unplayWild(w.chosenFreq)}
            />
          ))}

          {/* available charges floating above their source item */}
          {graph.charges.map((c) => (
            <ChargeChip
              key={c.id}
              node={c}
              canMove={canMove}
              armed={armed && c.charge === "strike"}
              onStrikeDown={onStrikeDown}
              onStrikeMove={onStrikeMove}
              onStrikeUp={onStrikeUp}
              onToggleArm={() => {
                // A real drag-to-strike ends with a synthesized click on this
                // button (pointer capture keeps it the target); without this
                // guard that click would flip `armed` on, silently arming the
                // click-to-strike fallback after every successful drag. The
                // drag lifecycle already flagged `moved`; consume it and bail.
                if (dragInfo.current.moved) {
                  dragInfo.current.moved = false;
                  return;
                }
                if (c.charge === "strike") setArmed((a) => !a);
              }}
              onOpenWild={(e) => openPickerAt(e.currentTarget as HTMLElement, null)}
            />
          ))}

          {/* ghost frequency circles the pinned perfume still needs to add */}
          {graph.ghostFrequencies.map((gf) => (
            <GhostFrequencyChip key={gf.id} node={gf} />
          ))}

          {/* ghost strikes — excess the closest path must remove (add-only
              path absent) */}
          {graph.ghostStrikes.map((gs) => (
            <GhostStrikeChip key={gs.id} node={gs} />
          ))}

          {/* ingredient band: item nodes (grab sources for the hand) */}
          {graph.items.map((it) => (
            <ItemChip
              key={it.id}
              node={it}
              hand={hand}
              canMove={canMove}
              ceremony={ceremony !== null}
            />
          ))}

          {/* combined band: named-frequency nodes at the top */}
          {graph.combined.map((c) => (
            <CombinedChip key={c.id} node={c} ceremony={ceremony !== null} />
          ))}
        </div>

        {/* outputs stacked on the rim as tinted bottles */}
        {snapshot.outputs.length > 0 && (
          <div className="absolute inset-x-0 top-2 z-[70] flex justify-center px-3">
            <OutputRim
              outputs={snapshot.outputs}
              canTake={permissions.brewAndTake}
              onTake={takeOutput}
              resolveName={resolveName}
            />
          </div>
        )}

        {/* the pin's satisfied glow banner */}
        {graph.pin?.satisfied && (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-[65] flex justify-center">
            <span
              className="rounded-full border border-success/60 bg-success/10 px-3 py-1 font-mono text-[11px] text-success shadow-lg"
              style={{ textShadow: "0 0 12px rgba(111,227,196,.5)" }}
            >
              {graph.pin.perfumeName}
              {(() => {
                const which = recipeLabel(graph.pin.perfumeId, graph.pin.reqIndex);
                return which ? ` (${which})` : "";
              })()}{" "}
              recipe satisfied{graph.pin.k > 1 ? ` ×${graph.pin.k}` : ""}
            </span>
          </div>
        )}

        {/* the ceremony overlay */}
        {ceremony && <Ceremony tint={ceremony.tint} k={ceremony.k} name={ceremony.name} />}
      </div>

      {/* the Brew action — appears when a recipe is satisfied */}
      <BrewFooter
        brewable={brewable}
        canBrew={canBrew}
        blockers={blockers}
        onBrew={runBrew}
        tallyCount={graph.cauldron.tallyCount}
      />

      {/* the dragged strike charge trailing the cursor */}
      {strikeDrag && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: strikeDrag.x, top: strikeDrag.y, boxShadow: `0 0 18px ${STRIKE}aa` }}
        >
          <ChargeSymbol kind="strike" size={38} />
        </div>
      )}

      {picker && (
        <WildcardPicker
          x={picker.x}
          y={picker.y}
          onPick={chooseWild}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

// ── stage header (name/nickname, deep link, brew-scale controls, undo/redo) ───

function StageHeader({
  snapshot,
  permissions,
  undo,
  actions,
  deepLink,
  onNickname,
  graph,
}: {
  snapshot: BrewSnapshot;
  permissions: BrewPermissions;
  undo: UndoState;
  actions: BrewActions;
  deepLink: string | null;
  onNickname?: (nickname: string) => void;
  graph: BrewGraphModel;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const defaultName = snapshot.isParty
    ? "Party brew"
    : `${snapshot.ownerName} brew ${snapshot.seq}`;
  const name = snapshot.nickname || defaultName;

  const copyLink = () => {
    if (!deepLink) return;
    try {
      void navigator.clipboard?.writeText(deepLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard unavailable (insecure context) — no confirmation
    }
  };

  const commitNickname = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== snapshot.nickname && onNickname) onNickname(next);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 font-mono text-xs text-text-muted">
      <div className="flex min-w-0 items-center gap-2">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitNickname}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNickname();
              if (e.key === "Escape") setEditing(false);
            }}
            placeholder={defaultName}
            spellCheck={false}
            className="min-w-0 rounded-md border border-border bg-bg px-2 py-1 text-sm text-text focus:border-accent focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!permissions.nickname || !onNickname) return;
              setDraft(snapshot.nickname ?? "");
              setEditing(true);
            }}
            title={permissions.nickname ? "Rename this brew" : name}
            className="min-w-0 truncate text-sm font-semibold uppercase tracking-[0.15em] text-text-faint hover:text-text"
          >
            {name}
          </button>
        )}
        {deepLink && (
          <button
            type="button"
            onClick={copyLink}
            aria-label="Copy this brew's link"
            title="Copy the deep link to this brew"
            className={cn(btn.ghost, "h-6 px-1.5")}
          >
            {copied ? "copied" : <LinkIcon />}
          </button>
        )}
        <span className="tabular-nums text-text-faint" title="frequencies counting toward recipes (after combination)">
          {graph.cauldron.tallyCount} freq
        </span>
        {/* the recipe the pin is steering toward (DESIGN.md §5) */}
        {graph.pin && (
          <span
            className="min-w-0 truncate text-accent/90"
            title="the recipe the pinned perfume's closest path is steering toward"
          >
            {(() => {
              const which = recipeLabel(graph.pin.perfumeId, graph.pin.reqIndex);
              return `steering toward ${graph.pin.perfumeName}${which ? ` — ${which}` : ""}`;
            })()}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1">
        {/* per-user undo / redo */}
        <button
          type="button"
          onClick={actions.undo}
          disabled={!undo.canUndo}
          aria-label="Undo your last move"
          title="Undo (your own moves only)"
          className={cn(btn.icon, "h-7 w-7 p-0")}
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          onClick={actions.redo}
          disabled={!undo.canRedo}
          aria-label="Redo your last move"
          title="Redo (your own moves only)"
          className={cn(btn.icon, "h-7 w-7 p-0 -scale-x-100")}
        >
          <UndoIcon />
        </button>

        <span className="mx-1 h-4 w-px bg-border" />

        {/* brew-scale controls */}
        <button
          type="button"
          onClick={actions.fillFromInventory}
          disabled={!permissions.fillReturn}
          aria-label="Fill hypothetical items from inventory"
          title="Fill from inventory — make every hypothetical item real"
          className={cn(btn.outline, "h-7 px-2")}
        >
          Fill
        </button>
        <button
          type="button"
          onClick={actions.returnIngredients}
          disabled={!permissions.fillReturn}
          aria-label="Return the brew's real ingredients to inventory"
          title="Return ingredients — send real items back to their owners"
          className={cn(btn.outline, "h-7 px-2")}
        >
          Return
        </button>
        <button
          type="button"
          onClick={actions.emptyBrew}
          disabled={!permissions.fillReturn || snapshot.items.length === 0}
          aria-label="Empty the brew"
          title="Empty brew — clear every item"
          className={cn(btn.danger, "h-7 border border-border px-2")}
        >
          Empty
        </button>
      </div>
    </div>
  );
}

// ── the Brew footer ───────────────────────────────────────────────────────────

function BrewFooter({
  brewable,
  canBrew,
  blockers,
  onBrew,
  tallyCount,
}: {
  brewable: BrewableOption | null;
  canBrew: boolean;
  blockers: string[];
  onBrew: () => void;
  tallyCount: number;
}) {
  if (!brewable) {
    return (
      <div data-testid="brew-bar" className="border-t border-border px-3 py-2 text-center">
        <p className="py-1 font-mono text-xs text-text-faint">
          {tallyCount === 0 ? "the cauldron is empty" : "no recipe is satisfied yet"}
        </p>
      </div>
    );
  }
  const label = brewable.k > 1 ? `${brewable.perfume.name} ×${brewable.k}` : brewable.perfume.name;
  const which = recipeLabel(brewable.perfume.key, brewable.recipeIndex);
  return (
    <div data-testid="brew-bar" className="flex items-center justify-center gap-2 border-t border-border px-3 py-2">
      <span
        className="font-display text-lg leading-none text-text"
        style={{ textShadow: "0 0 14px rgba(111,227,196,.5)" }}
      >
        {label}
      </span>
      {which && (
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-faint" title="the recipe this brew satisfies">
          {which}
        </span>
      )}
      <button
        type="button"
        disabled={!canBrew}
        onClick={onBrew}
        aria-label={`Brew ${label}`}
        title={canBrew ? `Brew ${label} — consumes the brew's real ingredients` : blockers.join(" · ") || "brewing is unavailable"}
        className="rounded-full border border-success/60 bg-success/10 px-4 py-1.5 font-mono text-xs uppercase tracking-wider text-success transition-colors duration-150 hover:bg-success/20 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-success/10"
      >
        Brew
      </button>
    </div>
  );
}

// ── edges ─────────────────────────────────────────────────────────────────────

// A cubic spline between two abstract stage points, in the current aesthetic
// (restyle allowed here — the old cauldron splines are gone). Kept subtle and
// in-palette: emit lines carry the frequency's colour, combine lines the
// combined frequency's, stems a slate; ghosts and charges dash.
function GraphEdges({ graph, ceremony }: { graph: BrewGraphModel; ceremony: boolean }) {
  const nodeById = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of graph.nodes) m.set(n.id, n.pos);
    return m;
  }, [graph]);

  const paths = useMemo(() => {
    const out: {
      key: string;
      d: string;
      color: string;
      dashed: boolean;
      opacity: number;
      width: number;
    }[] = [];
    for (const e of graph.edges) {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (!a || !b) continue;
      // splines fan upward: control points pull vertically between the bands
      const midY = (a.y + b.y) / 2;
      const d = `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
      let color = "#4b4980";
      let dashed = false;
      let opacity = 0.5;
      let width = 1.4;
      if (e.kind === "stem") {
        color = "#4b4980";
        opacity = 0.55;
        width = 2;
      } else if (e.kind === "emit") {
        const to = graph.frequencies.find((f) => f.id === e.to);
        color = to ? tokenColor(to.freq) : "#4b4980";
        opacity = to?.struck ? 0.2 : to?.consumed ? 0.3 : 0.5;
        dashed = !!to?.fromWild;
      } else if (e.kind === "grant") {
        const w = graph.wilds.find((n) => n.id === e.to);
        color = w ? COPPER : STRIKE;
        opacity = 0.4;
        dashed = true;
      } else if (e.kind === "combine") {
        const to = graph.combined.find((c) => c.id === e.to);
        color = to ? tokenColor(to.freq) : "#4b4980";
        opacity = 0.55;
      }
      out.push({ key: e.id, d, color, dashed, opacity, width });
    }
    return out;
  }, [graph, nodeById]);

  return (
    <svg
      className={cn(
        "pointer-events-none absolute inset-0 z-[1] h-full w-full transition-opacity duration-500",
        ceremony && "opacity-30",
      )}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {paths.map((p) => (
        <path
          key={p.key}
          d={p.d}
          fill="none"
          stroke={p.color}
          strokeWidth={p.width}
          strokeLinecap="round"
          strokeDasharray={p.dashed ? "4 4" : undefined}
          opacity={p.opacity}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

// ── node atoms ─────────────────────────────────────────────────────────────────

// A positioned slot wrapper: places a node at its abstract 0..100 position and
// applies the house drift/float feel. pf-slot smooths band reflow.
function Slot({
  id,
  pos,
  z,
  children,
  ...rest
}: {
  id: string;
  pos: { x: number; y: number };
  z: number;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className="pf-slot absolute"
      style={{ left: `${pos.x}%`, top: `${pos.y}%`, transform: "translate(-50%, -50%)", zIndex: z }}
      {...rest}
    >
      <div className="pf-float flex flex-col items-center gap-1" style={driftStyle(id)}>
        {children}
      </div>
    </div>
  );
}

function FrequencyChip({
  node,
  canMove,
  armed,
  strikeHover,
  ceremony,
  onArmedStrike,
  onUnstrike,
}: {
  node: FrequencyNode;
  canMove: boolean;
  armed: boolean;
  strikeHover: boolean;
  ceremony: boolean;
  onArmedStrike: () => void;
  onUnstrike: () => void;
}) {
  const dim = node.consumed ? 0.45 : 1;
  const draw = ceremony ? "translate-y-[40%] opacity-0" : "";
  return (
    <Slot id={node.id} pos={node.pos} z={20}>
      <div
        {...(!node.struck && !node.consumed ? { "data-strike-target": node.id } : {})}
        onClick={() => {
          if (!canMove) return;
          if (node.struck) onUnstrike();
          else onArmedStrike();
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!canMove) return;
            if (node.struck) onUnstrike();
            else onArmedStrike();
          }
        }}
        data-testid="freq-float"
        data-freq={node.freq}
        data-kind="freq"
        aria-label={
          node.struck
            ? `${node.freq} struck — click to un-strike`
            : `${node.freq} frequency${node.fromWild ? " (from a wild)" : ""}${node.consumed ? " — combined away" : ""}`
        }
        title={
          node.struck
            ? `${node.freq} — struck (click to restore)`
            : node.consumed
              ? `${node.freq} — combined away`
              : node.freq
        }
        className={cn(
          "relative cursor-pointer rounded-full transition-[filter,opacity,transform] duration-500",
          (strikeHover || armed) && !node.struck && !node.consumed ? "ring-2 ring-offset-2 ring-offset-bg" : "",
          draw,
        )}
        style={{
          opacity: node.consumed ? dim : 1,
          filter: node.consumed ? "grayscale(0.8)" : "none",
          ...(strikeHover || armed
            ? ({ ["--tw-ring-color" as string]: STRIKE } as React.CSSProperties)
            : {}),
        }}
      >
        <FrequencySymbol id={node.freq} size={44} />
        {node.fromWild && !node.struck && (
          <span
            className="absolute -right-1 -top-1 grid h-3.5 w-3.5 place-items-center rounded-full text-[8px] font-bold"
            style={{ background: COPPER, color: "#14132B" }}
          >
            +
          </span>
        )}
        {/* the strike's VIOLET COVER (DESIGN.md §1: covers, not greys out) */}
        {node.struck && (
          <span
            className="pointer-events-none absolute inset-0 grid place-items-center rounded-full"
            style={{ background: `${STRIKE}cc`, boxShadow: `inset 0 0 0 2px ${STRIKE}` }}
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
              <path d="M4 12h16" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </span>
        )}
      </div>
      <ChipLabel>{node.struck ? "struck" : frequencyLabel(node.freq)}</ChipLabel>
    </Slot>
  );
}

function CombinedChip({ node, ceremony }: { node: CombinedNode; ceremony: boolean }) {
  return (
    <Slot id={node.id} pos={node.pos} z={40}>
      <div
        className={cn("transition-[opacity,transform] duration-500", ceremony && "translate-y-[40%] opacity-0")}
        style={{ opacity: node.consumed ? 0.45 : 1, filter: node.consumed ? "grayscale(0.8)" : "none" }}
        title={node.consumed ? `${node.freq} — combined further` : `${node.freq} — combined from the brew`}
        data-testid="freq-float"
        data-freq={node.freq}
        data-kind="combined"
      >
        <FrequencySymbol id={node.freq} size={44} />
      </div>
      <ChipLabel>{node.freq}</ChipLabel>
    </Slot>
  );
}

function ChargeChip({
  node,
  canMove,
  armed,
  onStrikeDown,
  onStrikeMove,
  onStrikeUp,
  onToggleArm,
  onOpenWild,
}: {
  node: ChargeNode;
  canMove: boolean;
  armed: boolean;
  onStrikeDown: (e: ReactPointerEvent) => void;
  onStrikeMove: (e: ReactPointerEvent) => void;
  onStrikeUp: (e: ReactPointerEvent) => void;
  onToggleArm: () => void;
  onOpenWild: (e: ReactMouseEvent) => void;
}) {
  if (node.charge === "strike") {
    return (
      <Slot id={node.id} pos={node.pos} z={22}>
        <button
          type="button"
          disabled={!canMove}
          onPointerDown={onStrikeDown}
          onPointerMove={onStrikeMove}
          onPointerUp={onStrikeUp}
          onClick={onToggleArm}
          aria-label="Strike charge — drag onto a frequency to strike it"
          title="Strike: drag onto a frequency circle to seal it (or click to arm)"
          className={cn(
            "cursor-grab touch-none select-none rounded-full active:cursor-grabbing disabled:cursor-not-allowed",
            armed ? "ring-2 ring-offset-2 ring-offset-bg" : "",
          )}
          style={{
            boxShadow: `0 0 14px ${STRIKE}55`,
            ...(armed ? ({ ["--tw-ring-color" as string]: STRIKE } as React.CSSProperties) : {}),
          }}
        >
          <ChargeSymbol kind="strike" size={44} />
        </button>
        <ChipLabel>strike</ChipLabel>
      </Slot>
    );
  }
  return (
    <Slot id={node.id} pos={node.pos} z={22}>
      <button
        type="button"
        disabled={!canMove}
        onClick={onOpenWild}
        aria-label="Wild charge — click to choose a frequency to add"
        title="Wild: click to add any frequency"
        className="cursor-pointer rounded-full disabled:cursor-not-allowed"
        style={{ boxShadow: `0 0 14px ${COPPER}55` }}
      >
        <ChargeSymbol kind="wild" size={44} />
      </button>
      <ChipLabel>wild</ChipLabel>
    </Slot>
  );
}

function WildChip({
  node,
  canMove,
  onOpen,
  onDispel,
}: {
  node: WildNode;
  canMove: boolean;
  onOpen: (e: ReactMouseEvent) => void;
  onDispel: () => void;
}) {
  const chosen = node.chosenFreq;
  return (
    <Slot id={node.id} pos={node.pos} z={24}>
      <button
        type="button"
        disabled={!canMove}
        onClick={onOpen}
        onContextMenu={(e) => {
          e.preventDefault();
          if (canMove && chosen) onDispel();
        }}
        aria-label={chosen ? `Wild set to ${chosen} — click to change` : "Wild — click to choose a frequency"}
        title={chosen ? `Wild → ${chosen} (click to change, right-click to dispel)` : "Wild — click to choose a frequency"}
        className="relative cursor-pointer rounded-full disabled:cursor-not-allowed"
        style={{ boxShadow: `0 0 14px ${COPPER}55` }}
      >
        {chosen ? <FrequencyGlyph id={chosen} size={44} /> : <ChargeSymbol kind="wild" size={44} />}
        <span
          className="absolute -bottom-1 -right-1 grid h-3.5 w-3.5 place-items-center rounded-full text-[9px] font-bold"
          style={{ background: COPPER, color: "#14132B" }}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>
      <ChipLabel>{chosen ? frequencyLabel(chosen) : "wild"}</ChipLabel>
    </Slot>
  );
}

function GhostFrequencyChip({ node }: { node: GhostFrequencyNode }) {
  return (
    <Slot id={node.id} pos={node.pos} z={12}>
      <div
        className="rounded-full opacity-35"
        style={{ filter: "grayscale(0.4)" }}
        title={`needed: ${node.freq}`}
        data-testid="ghost-freq"
        data-freq={node.freq}
      >
        <FrequencyGlyph id={node.freq} size={40} className="border-dashed" />
      </div>
      <ChipLabel>{frequencyLabel(node.freq)}</ChipLabel>
    </Slot>
  );
}

// A ghost STRIKE: the closest path can only reach the pinned perfume by removing
// this excess frequency. Rendered as a dashed strike (purple cover, dashed
// outline) so it reads as "strike here" without being an actual played strike.
function GhostStrikeChip({ node }: { node: GhostStrikeNode }) {
  return (
    <Slot id={node.id} pos={node.pos} z={12}>
      <div
        className="relative rounded-full opacity-45"
        title={`strike a ${node.freq} to reach the pinned perfume`}
        data-testid="ghost-strike"
        data-freq={node.freq}
      >
        <FrequencyGlyph id={node.freq} size={40} className="border-dashed" />
        <span
          className="pointer-events-none absolute inset-0 grid place-items-center rounded-full border border-dashed"
          style={{ background: `${STRIKE}55`, borderColor: STRIKE }}
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
            <path d="M4 12h16" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="3 3" />
          </svg>
        </span>
      </div>
      <ChipLabel>strike {frequencyLabel(node.freq)}</ChipLabel>
    </Slot>
  );
}

function ItemChip({
  node,
  hand,
  canMove,
  ceremony,
}: {
  node: ItemNode;
  hand: BrewHand;
  canMove: boolean;
  ceremony: boolean;
}) {
  const hypothetical = node.hypothetical > 0;
  const title = hypothetical
    ? `${node.name} ×${node.count} — ${node.hypothetical} hypothetical (${node.contributors.join(", ")}); hypotheticals block brewing`
    : `${node.name}${node.count > 1 ? ` ×${node.count}` : ""} — click to pick up, right-click to return one`;

  return (
    <Slot id={`ing:${node.id}`} pos={node.pos} z={60}>
      <div
        role="button"
        tabIndex={0}
        data-testid="arc-ingredient"
        data-item-key={node.itemKey}
        onClick={(e) => {
          if (!canMove) return;
          if (e.shiftKey) {
            hand.moveHome(node.itemKey, 1);
            return;
          }
          hand.pickUp(node.itemKey, "brew", node.count);
        }}
        onContextMenu={(e) => {
          if (hand.hand) return;
          e.preventDefault();
          if (canMove) hand.moveHome(node.itemKey, 1);
        }}
        onPointerDown={(e) => hand.beginPress(e, node.itemKey, "brew", node.count)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (canMove) hand.pickUp(node.itemKey, "brew", node.count);
          }
        }}
        onDragStart={(e) => e.preventDefault()}
        aria-label={`${node.name} ×${node.count} in the brew — click to pick up, right-click to return one, shift-click to send one home`}
        title={title}
        className={cn(
          "relative cursor-grab touch-none rounded-lg transition-[opacity,transform] duration-500",
          hypothetical ? "outline-dashed outline-2 outline-offset-2 outline-amber-400/80" : "",
          ceremony && "scale-90 opacity-30",
        )}
      >
        <ItemArt itemKey={node.itemKey} name={node.name} color={node.color} size={56} />
        <CountBadge count={node.count} className="absolute -right-2 -top-2" />
      </div>
      <ChipLabel>{node.name}</ChipLabel>
    </Slot>
  );
}

// ── outputs on the rim ──────────────────────────────────────────────────────────

function OutputRim({
  outputs,
  canTake,
  onTake,
  resolveName,
}: {
  outputs: OutputInstance[];
  canTake: boolean;
  onTake: (instanceId: string) => void;
  resolveName: NameResolver;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex flex-wrap items-start justify-center gap-3 rounded-xl border border-border bg-surface/80 px-3 py-2 shadow-lg backdrop-blur-sm">
        {outputs.map((o) => {
          const name = perfumeName(o.perfumeId);
          const tint = perfumeTint(o.perfumeId);
          // provenance travels with the instance (DESIGN.md §1,§9); the take
          // affordance line follows it in the hover tooltip.
          const provenance = provenanceTooltip(
            { brewedByKey: o.brewedByKey, witnesses: o.witnesses, brewedAt: o.brewedAt, chain: o.provenance },
            resolveName,
          );
          const take = canTake
            ? "Click to take one into your inventory"
            : "Only the brew owner may take perfumes";
          return (
            <button
              key={o.instanceId}
              type="button"
              data-testid="output-phial"
              data-perfume-key={o.perfumeId}
              disabled={!canTake}
              onClick={() => onTake(o.instanceId)}
              aria-label={
                canTake
                  ? `${name} ×${o.count} brewed — click to take one`
                  : `${name} ×${o.count} brewed — only the brew owner may take it`
              }
              title={`${provenance}\n${take}`}
              className="touch-none rounded-lg outline-none transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-accent enabled:cursor-pointer enabled:hover:scale-105 disabled:cursor-not-allowed"
            >
              <TintedBottle name={name} count={o.count} tint={tint} dimmed={!canTake} />
            </button>
          );
        })}
      </div>
      {!canTake && (
        <p className="font-mono text-[10px] text-text-faint">only the brew owner may take these</p>
      )}
    </div>
  );
}

// A perfume bottle tinted by the blend of its recipe's fundamentals (DESIGN.md
// §7 — the generic phial silhouette, glass washed in the blend colour).
function TintedBottle({ name, count, tint, dimmed }: { name: string; count: number; tint: string; dimmed: boolean }) {
  return (
    <span className="flex flex-col items-center gap-1" style={{ opacity: dimmed ? 0.55 : 1 }}>
      <span className="relative grid place-items-center">
        {/* the tint wash behind the glass */}
        <span
          className="pointer-events-none absolute inset-0 rounded-full blur-[6px]"
          style={{ background: tint, opacity: 0.5 }}
          aria-hidden="true"
        />
        <span className="relative" style={{ color: tint }}>
          <PhialGlyph size={44} />
        </span>
        <CountBadge count={count} className="absolute -right-2 -top-1" />
      </span>
      <ChipLabel>{name}</ChipLabel>
    </span>
  );
}

// ── the vessel ─────────────────────────────────────────────────────────────────

function CauldronVessel({ active, tint }: { active: boolean; tint: string }) {
  // The liquid tints to the blend of the tally's fundamentals (layout model).
  return (
    <svg viewBox="0 0 260 180" className="h-full max-h-[260px] w-auto" aria-hidden="true">
      <defs>
        <radialGradient id="pf-brew" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stopColor={active ? mix(tint, 0.4) : "#1b2a3a"} />
          <stop offset="55%" stopColor={active ? tint : "#1b2a3a"} />
          <stop offset="100%" stopColor={active ? mix(tint, -0.35) : "#14213a"} />
        </radialGradient>
        <linearGradient id="pf-vessel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#262549" />
          <stop offset="100%" stopColor="#14132B" />
        </linearGradient>
      </defs>

      {active && (
        <g style={{ transformOrigin: "center" }}>
          <ellipse className="pf-steam" style={{ ["--pf-dur" as string]: "5s" }} cx="105" cy="60" rx="6" ry="10" fill={tint} opacity="0.25" />
          <ellipse className="pf-steam" style={{ ["--pf-dur" as string]: "6.5s", ["--pf-delay" as string]: "-2s" }} cx="135" cy="58" rx="7" ry="12" fill={tint} opacity="0.2" />
          <ellipse className="pf-steam" style={{ ["--pf-dur" as string]: "5.8s", ["--pf-delay" as string]: "-3.5s" }} cx="120" cy="55" rx="5" ry="9" fill={mix(tint, 0.3)} opacity="0.18" />
        </g>
      )}

      <ellipse cx="130" cy="78" rx="92" ry="20" fill="url(#pf-vessel)" stroke="#3a3866" strokeWidth="2" />
      <ellipse cx="130" cy="76" rx="80" ry="15" fill="url(#pf-brew)" className={active ? "pf-glow" : ""} />
      {active && (
        <g>
          <circle className="pf-bubble" style={{ ["--pf-dur" as string]: "2.6s" }} cx="112" cy="74" r="3" fill={mix(tint, 0.5)} />
          <circle className="pf-bubble" style={{ ["--pf-dur" as string]: "3.2s", ["--pf-delay" as string]: "-1s" }} cx="140" cy="76" r="4" fill={mix(tint, 0.5)} />
          <circle className="pf-bubble" style={{ ["--pf-dur" as string]: "2.9s", ["--pf-delay" as string]: "-1.8s" }} cx="128" cy="72" r="2.5" fill={mix(tint, 0.7)} />
        </g>
      )}

      <path
        d="M40 80 C40 150 75 172 130 172 C185 172 220 150 220 80 C200 96 165 104 130 104 C95 104 60 96 40 80 Z"
        fill="url(#pf-vessel)"
        stroke="#3a3866"
        strokeWidth="2.5"
      />
      <path d="M60 96 C70 130 95 150 130 154" fill="none" stroke="#4b4980" strokeWidth="3" strokeLinecap="round" opacity="0.5" />
      <ellipse cx="42" cy="86" rx="8" ry="12" fill="none" stroke="#3a3866" strokeWidth="4" />
      <ellipse cx="218" cy="86" rx="8" ry="12" fill="none" stroke="#3a3866" strokeWidth="4" />
      <path d="M86 170 l-8 10 M174 170 l8 10 M130 174 l0 10" stroke="#3a3866" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

// Lighten (t>0) or darken (t<0) a hex colour toward white/black by |t|, via
// lib/color's shared two-colour mix.
function mix(hex: string, t: number): string {
  return mixHex(hex, t >= 0 ? "#ffffff" : "#000000", Math.abs(t));
}

// ── the ceremony ────────────────────────────────────────────────────────────────

// A short, classy completion sequence in the house animation language: the
// stage dims, a liquid-coloured flash blooms from the cauldron, and a tinted
// bottle pops (pf-pop) with the perfume's name. Reduced-motion shows a brief
// static confirmation instead of the animation.
function Ceremony({ tint, k, name }: { tint: string; k: number; name: string }) {
  const reduced = prefersReducedMotion();
  return (
    <div className="pointer-events-none absolute inset-0 z-[80] overflow-hidden" aria-live="polite">
      {/* the flash bloom rising out of the cauldron */}
      {!reduced && (
        <span
          className="absolute left-1/2 top-[78%] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: "min(90%, 520px)",
            height: "min(90%, 520px)",
            background: `radial-gradient(circle, ${tint}aa 0%, ${tint}44 40%, transparent 70%)`,
            animation: "pf-pop 0.9s cubic-bezier(0.22,1,0.36,1) both",
          }}
          aria-hidden="true"
        />
      )}
      {/* the bottle pop with its name */}
      <div className="absolute inset-0 grid place-items-center">
        <div className="pf-pop flex flex-col items-center gap-2">
          <span className="relative grid place-items-center" style={{ color: tint }}>
            <span
              className="pointer-events-none absolute inset-0 rounded-full blur-lg"
              style={{ background: tint, opacity: 0.55 }}
              aria-hidden="true"
            />
            <span className="relative">
              <PhialGlyph size={88} />
            </span>
          </span>
          <span
            className="font-display text-xl text-text"
            style={{ textShadow: `0 0 18px ${tint}` }}
          >
            {k > 1 ? `${name} ×${k}` : name}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── the wildcard picker (reused from the old cauldron, in-palette) ───────────────

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

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

  return (
    <Popover
      anchor={{ x, y }}
      align="center"
      width={260}
      label="Choose the wild's frequency"
      onClose={onClose}
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
              <span className="ml-auto text-[10px] uppercase tracking-wider text-text-faint">
                {t.kind}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}

// ── icons ───────────────────────────────────────────────────────────────────────

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
    </svg>
  );
}
