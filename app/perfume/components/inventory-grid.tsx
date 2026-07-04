"use client";

// The inventory grid at the top of the input panel: three auto-growing
// sections (ingredients / pure frequencies / perfumes) of icon slots with
// count badges. Slots obey the hand grammar (DESIGN.md); a slot with copies
// in the brew keeps its place but ghosts the icon — "you took the icon".
// Owner-only per-slot Send opens a member + count popover -> onTransfer.

import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { Ingredient } from "../lib/types";
import type { HandOrigin, Inventory } from "../lib/bench-types";
import type { BenchHand } from "../lib/use-hand";
import { isPureKey } from "../data/base";
import { ChargeSymbol, FrequencySymbol, PHIAL } from "../lib/frequencies";
import IngredientThumb from "./ingredient-thumb";

// ── the hand grammar, wired once ─────────────────────────────────────────────
// Shared by inventory slots and catalog rows: pointer-down picks up (the hand
// owns drag tracking and the boundary rule from there), shift-click teleports
// one unit to the brew, right-click returns one from a held stack or — with an
// empty hand on an in-brew item — puts one back to inventory. Hover only
// reports the key; what previews where is the client's business.

export type GrabSpec = {
  itemKey: string;
  from: HandOrigin;
  available: number; // cap for pickUp; Infinity for the boundless catalog
  inBrew: number;
  hand: BenchHand;
  canMove: boolean;
  onHover: (itemKey: string | null) => void;
  onShiftToBrew?: (itemKey: string) => void;
  onUnbrewOne?: (itemKey: string) => void;
};

export function grabHandlers(spec: GrabSpec) {
  const h = spec.hand.hand;
  // pickUp caps at what's still free to take from this source
  const held =
    h && h.itemKey === spec.itemKey && h.from === spec.from ? h.count : 0;
  const room = spec.available - held;
  return {
    onMouseEnter: () => spec.onHover(spec.itemKey),
    onMouseLeave: () => spec.onHover(null),
    // press only ARMS a potential drag; the pickup itself happens on click so
    // it cooperates with the hand's click/drag guards (a pickup on pointerdown
    // would be canceled by its own trailing click, and a drag release would
    // re-pick) — same split the cauldron arc and output shelf use
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || e.shiftKey || !spec.canMove || room <= 0) return;
      spec.hand.beginPress(e, spec.itemKey, spec.from, room);
    },
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      if (!spec.canMove) return;
      // shift is the teleport modifier, resolved on click
      if (e.shiftKey) {
        spec.onShiftToBrew?.(spec.itemKey);
        return;
      }
      if (room <= 0) return;
      spec.hand.pickUp(spec.itemKey, spec.from, room);
    },
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault();
      if (!spec.canMove) return;
      // holding: the hand's own window listener returns one (and eats the
      // menu) — acting here too would return a second unit
      if (spec.hand.hand) return;
      if (spec.inBrew > 0) spec.onUnbrewOne?.(spec.itemKey);
    },
    // the art tiles are <img>s — never let the browser start a native drag
    onDragStart: (e: ReactDragEvent<HTMLElement>) => e.preventDefault(),
  };
}

// ── shared visual atoms ──────────────────────────────────────────────────────

// The ×n badge that sits on slot and thumbnail corners.
export function CountBadge({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={`pointer-events-none rounded border border-border/70 bg-surface/95 px-1 font-mono text-[10px] font-bold leading-4 tabular-nums text-text ${className ?? ""}`}
    >
      ×{n}
    </span>
  );
}

// A simple corked phial — the icon for perfume slots (no crest art exists).
export function PhialIcon({ size = 30, color = PHIAL }: { size?: number; color?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ flex: "0 0 auto" }}
    >
      <path d="M9.6 2.6h4.8v2.6H9.6z" fill={color} opacity="0.85" />
      <path
        d="M10.2 5.2v3.1C7.2 9.6 5.4 12.2 5.4 15.1a6.6 6.6 0 0 0 13.2 0c0-2.9-1.8-5.5-4.8-6.8V5.2Z"
        fill={`${color}26`}
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M5.7 15.7a6.4 6.4 0 0 0 12.6 0Z" fill={color} opacity="0.55" />
    </svg>
  );
}

function SendMark({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22 11 13 2 9Z" />
    </svg>
  );
}

// ── the grid ─────────────────────────────────────────────────────────────────

export type InventorySlotItem = {
  key: string;
  name: string;
  count: number; // owned (still in the inventory section)
  inBrew: number; // copies currently in the brew -> ghosted icon
  ing?: Ingredient; // ingredient/pure slots; perfume slots render the phial
};

export interface InventoryGridProps {
  sections: {
    id: keyof Inventory;
    label: string;
    items: InventorySlotItem[];
    owned: number; // total units owned pre-filter — tells "empty" from "hidden"
  }[];
  hand: BenchHand;
  canMove: boolean;
  canTransfer: boolean;
  members: { benchKey: string; name: string }[];
  onHover: (itemKey: string | null) => void;
  onTransfer: (toBenchKey: string, itemKey: string, n: number) => void;
  onShiftToBrew?: (itemKey: string) => void;
  onUnbrewOne?: (itemKey: string) => void;
}

type SendAnchor = { itemKey: string; name: string; max: number; x: number; y: number };

export default function InventoryGrid({
  sections,
  hand,
  canMove,
  canTransfer,
  members,
  onHover,
  onTransfer,
  onShiftToBrew,
  onUnbrewOne,
}: InventoryGridProps) {
  const [send, setSend] = useState<SendAnchor | null>(null);

  return (
    <div className="pb-1">
      {sections.map((s) => (
        <section key={s.id} aria-label={s.label}>
          <h3 className="flex items-baseline justify-between px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-text-faint">
            <span>{s.label}</span>
            <span className="tabular-nums">{s.owned}</span>
          </h3>
          {s.items.length === 0 ? (
            <p className="px-3 pb-2 font-mono text-[10px] italic text-text-faint">
              {s.owned === 0 ? "nothing yet" : "hidden by filters"}
            </p>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-1.5 px-3 pb-2">
              {s.items.map((item) => (
                <Slot
                  key={item.key}
                  item={item}
                  hand={hand}
                  canMove={canMove}
                  showSend={canTransfer && members.length > 0}
                  onHover={onHover}
                  onShiftToBrew={onShiftToBrew}
                  onUnbrewOne={onUnbrewOne}
                  onSend={setSend}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
      {send && (
        <SendPopover
          anchor={send}
          members={members}
          onTransfer={onTransfer}
          onClose={() => setSend(null)}
        />
      )}
    </div>
  );
}

function SlotIcon({ item }: { item: InventorySlotItem }) {
  const ing = item.ing;
  if (!ing) return <PhialIcon size={30} />;
  if (isPureKey(ing.key)) {
    const id = ing.key.slice(5);
    return id === "strike" || id === "wild" ? (
      <ChargeSymbol kind={id} size={30} />
    ) : (
      <FrequencySymbol id={id} size={30} />
    );
  }
  return <IngredientThumb name={ing.name} source={ing.source} color={ing.color} size={44} />;
}

function Slot({
  item,
  hand,
  canMove,
  showSend,
  onHover,
  onShiftToBrew,
  onUnbrewOne,
  onSend,
}: {
  item: InventorySlotItem;
  hand: BenchHand;
  canMove: boolean;
  showSend: boolean;
  onHover: (itemKey: string | null) => void;
  onShiftToBrew?: (itemKey: string) => void;
  onUnbrewOne?: (itemKey: string) => void;
  onSend: (a: SendAnchor) => void;
}) {
  const g = grabHandlers({
    itemKey: item.key,
    from: "inventory",
    available: item.count,
    inBrew: item.inBrew,
    hand,
    canMove,
    onHover,
    // shift-teleport targets the brew — meaningless for perfume slots
    onShiftToBrew: item.ing ? onShiftToBrew : undefined,
    onUnbrewOne,
  });
  const ghost = item.inBrew > 0;

  return (
    <li className="group relative">
      <button
        type="button"
        {...g}
        data-testid="inventory-slot"
        data-item-key={item.key}
        aria-label={`Pick up ${item.name}`}
        aria-disabled={!canMove || undefined}
        title={`${item.name} ×${item.count}${ghost ? ` — ${item.inBrew} in the brew` : ""}`}
        className="grid h-14 w-full touch-none select-none place-items-center rounded-lg border border-border/60 bg-bg/40 transition-colors duration-150 hover:border-accent/60 hover:bg-surface-alt"
      >
        <span className={`inline-flex transition-opacity duration-150 ${ghost ? "opacity-35" : ""}`}>
          <SlotIcon item={item} />
        </span>
      </button>
      {item.count > 0 && <CountBadge n={item.count} className="absolute bottom-0.5 right-0.5" />}
      {showSend && item.count > 0 && (
        <button
          type="button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onSend({ itemKey: item.key, name: item.name, max: item.count, x: r.right, y: r.bottom });
          }}
          aria-label={`Send ${item.name} to a party member`}
          title="Send to a party member"
          className="absolute -right-1 -top-1 z-10 grid h-5 w-5 place-items-center rounded-full border border-border bg-surface text-text-faint opacity-0 shadow transition-opacity duration-150 hover:border-accent hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
        >
          <SendMark size={11} />
        </button>
      )}
    </li>
  );
}

// ── send popover ─────────────────────────────────────────────────────────────

function SendPopover({
  anchor,
  members,
  onTransfer,
  onClose,
}: {
  anchor: SendAnchor;
  members: { benchKey: string; name: string }[];
  onTransfer: (toBenchKey: string, itemKey: string, n: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [to, setTo] = useState(members[0]?.benchKey ?? "");
  const [n, setN] = useState(1);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // clamp on-screen (fixed portal), floor degenerate viewports like the
  // frequency popover does
  const W = 232;
  const vw = Math.max(typeof window !== "undefined" ? window.innerWidth : 1024, 360);
  const left = Math.min(Math.max(anchor.x - W, 8), vw - W - 8);
  const count = Math.min(Math.max(Math.round(n) || 0, 0), anchor.max);
  const valid = to !== "" && count >= 1;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Send ${anchor.name}`}
      className="fixed z-[75] rounded-lg border border-border bg-surface p-2.5 shadow-xl"
      style={{ left, top: anchor.y + 6, width: W }}
    >
      <p className="mb-2 truncate font-mono text-[10px] uppercase tracking-wider text-text-faint">
        send {anchor.name}
      </p>
      <select
        value={to}
        onChange={(e) => setTo(e.target.value)}
        aria-label="Send to"
        className="mb-2 w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-text focus:border-accent focus:outline-none"
      >
        {members.map((m) => (
          <option key={m.benchKey} value={m.benchKey}>
            {m.name}
          </option>
        ))}
      </select>
      <div className="flex items-stretch gap-2">
        <input
          type="number"
          min={1}
          max={anchor.max}
          value={n}
          onChange={(e) => setN(Number(e.target.value))}
          aria-label="How many"
          className="w-16 rounded-md border border-border bg-bg px-2 py-1.5 text-center font-mono text-xs text-text focus:border-accent focus:outline-none"
        />
        <span className="self-center font-mono text-[10px] text-text-faint">of {anchor.max}</span>
        <button
          type="button"
          disabled={!valid}
          onClick={() => {
            onTransfer(to, anchor.itemKey, count);
            onClose();
          }}
          className="ml-auto rounded-md border border-accent/60 bg-accent/10 px-2.5 py-1 font-mono text-xs font-semibold text-accent transition-colors duration-150 hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>,
    document.body,
  );
}
