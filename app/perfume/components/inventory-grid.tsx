"use client";

// The inventory grid — an inventory rendered as a grid of item FRAMES
// (DESIGN.md §1 "item frame", §Layout). Three auto-growing sections
// (ingredients / pure frequencies / perfumes) of rounded-square slots with
// count badges. Slots obey the hand grammar (DESIGN.md §5); a slot whose copies
// all sit in the brew keeps its place but ghosts its art — "you took the icon".
// Owner-only per-slot Send opens a member + count popover -> onGift (which the
// store routes to giftItem).

import {
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Popover } from "./popover";
import type { Ingredient } from "../lib/types";
import type { Inventory } from "../lib/brew-types";
import type { HandOrigin, BrewHand } from "../lib/use-hand";
import { NAMED_GREEN } from "../lib/frequencies";
import ItemFrame, { type FrameItem } from "./item-frame";
import { SendGlyph } from "./glyphs";
import { btn, cn } from "./ui";

// ── the hand grammar, wired once ─────────────────────────────────────────────
// Shared by inventory slots, catalog rows, and (since Stage B) the brew graph's
// item chips: pointer-down picks up (the hand owns drag tracking and the
// boundary rule from there), shift-click teleports one unit, right-click returns
// one from a held stack or — with an empty hand on an in-brew item — puts one
// back to inventory. The teleport direction depends on the ORIGIN: from an
// inventory/catalog slot shift-click sends one INTO the brew; from a "brew"
// graph item shift-click / empty-hand right-click send one back HOME (absorbing
// the moveHome / shift-home the graph's ItemChip used to hand-roll).

export type GrabSpec = {
  itemKey: string;
  from: HandOrigin;
  available: number; // cap for pickUp; Infinity for the boundless catalog
  inBrew: number;
  hand: BrewHand;
  canMove: boolean;
  onShiftToBrew?: (itemKey: string) => void;
  onUnbrewOne?: (itemKey: string) => void;
};

export function grabHandlers(spec: GrabSpec) {
  const h = spec.hand.hand;
  // pickUp caps at what's still free to take from this source
  const held =
    h && h.itemKey === spec.itemKey && h.from === spec.from ? h.count : 0;
  const room = spec.available - held;
  // A "brew" item already sits IN the brew, so its teleport moves run the
  // OPPOSITE way to an inventory/catalog slot: shift-click and empty-hand
  // right-click both send one copy straight HOME to inventory (the moveHome /
  // shift-home the graph's ItemChip used to hand-roll). A plain click still
  // picks one up — from the brew this time.
  const fromBrew = spec.from === "brew";
  return {
    // press only ARMS a potential drag; the pickup itself happens on click so
    // it cooperates with the hand's click/drag guards (a pickup on pointerdown
    // would be canceled by its own trailing click, and a drag release would
    // re-pick) — same split the cauldron arc and cauldron outputs use
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || e.shiftKey || !spec.canMove || room <= 0) return;
      spec.hand.beginPress(e, spec.itemKey, spec.from, room);
    },
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      if (!spec.canMove) return;
      // shift is the teleport modifier, resolved on click
      if (e.shiftKey) {
        if (fromBrew) spec.hand.moveHome(spec.itemKey, 1);
        else spec.onShiftToBrew?.(spec.itemKey);
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
      if (fromBrew) spec.hand.moveHome(spec.itemKey, 1);
      else if (spec.inBrew > 0) spec.onUnbrewOne?.(spec.itemKey);
    },
    // the art tiles are <img>s — never let the browser start a native drag
    onDragStart: (e: ReactDragEvent<HTMLElement>) => e.preventDefault(),
  };
}

// ── shared visual atoms ──────────────────────────────────────────────────────
// The ×n badge is item-frame's FrameCountBadge — the single source of truth,
// used here through <ItemFrame count=…>; the catalog rows import it directly.
// The send arrow is the shared SendGlyph (components/glyphs.tsx).

// ── the grid ─────────────────────────────────────────────────────────────────

export type InventorySlotItem = {
  key: string;
  name: string;
  count: number; // owned (still in the inventory section)
  inBrew: number; // copies currently in the brew -> ghosted icon
  ing?: Ingredient; // ingredient/pure slots; perfume slots render the perfume glyph
  // extra hover copy appended after the "{name} ×{count}" line — perfume slots
  // carry their instance provenance here (DESIGN.md §1,§9).
  provenance?: string;
};

export interface InventoryGridProps {
  sections: {
    id: keyof Inventory;
    label: string;
    items: InventorySlotItem[];
    owned: number; // total units owned pre-filter — tells "empty" from "hidden"
  }[];
  hand: BrewHand;
  canMove: boolean;
  canGift: boolean;
  /** May act on this (own) inventory — gates the right-click discard menu. */
  canEditInventory: boolean;
  members: { memberKey: string; name: string }[];
  onGift: (toMemberKey: string, itemKey: string, n: number) => void;
  onShiftToBrew?: (itemKey: string) => void;
  onUnbrewOne?: (itemKey: string) => void;
  /** Discard n of an item from this inventory (permanent). §5 context menu. */
  onDiscard?: (itemKey: string, n: number) => void;
}

type SendAnchor = { itemKey: string; name: string; max: number; x: number; y: number };
type MenuAnchor = { itemKey: string; name: string; count: number; inBrew: number; x: number; y: number };

export default function InventoryGrid({
  sections,
  hand,
  canMove,
  canGift,
  canEditInventory,
  members,
  onGift,
  onShiftToBrew,
  onUnbrewOne,
  onDiscard,
}: InventoryGridProps) {
  const [send, setSend] = useState<SendAnchor | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

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
                  showSend={canGift && members.length > 0}
                  canEditInventory={canEditInventory && !!onDiscard}
                  onShiftToBrew={onShiftToBrew}
                  onUnbrewOne={onUnbrewOne}
                  onSend={setSend}
                  onMenu={setMenu}
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
          onGift={onGift}
          onClose={() => setSend(null)}
        />
      )}
      {menu && (
        <SlotMenu
          anchor={menu}
          onUnbrewOne={onUnbrewOne}
          onDiscard={onDiscard}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// Right-click context menu for an OWN-inventory slot (DESIGN.md §5): return one
// copy from the brew (when some sit there) and DELETE the item — one copy or the
// whole stack. Delete is permanent (DESIGN.md §9 conservation: the one destroy
// path besides brewing). Built on the shared Popover.
function SlotMenu({
  anchor,
  onUnbrewOne,
  onDiscard,
  onClose,
}: {
  anchor: MenuAnchor;
  onUnbrewOne?: (itemKey: string) => void;
  onDiscard?: (itemKey: string, n: number) => void;
  onClose: () => void;
}) {
  const item = (label: string, danger: boolean, run: () => void) => (
    <button
      type="button"
      onClick={() => {
        run();
        onClose();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-xs",
        danger ? "text-error hover:bg-error/10" : "text-text-muted hover:bg-surface-alt",
      )}
    >
      {label}
    </button>
  );
  return (
    <Popover
      anchor={{ x: anchor.x, y: anchor.y }}
      align="left"
      width={200}
      role="menu"
      label={`${anchor.name} actions`}
      onClose={onClose}
      className="p-1"
    >
      <p className="truncate px-2 pb-1 pt-0.5 font-mono text-[10px] uppercase tracking-wider text-text-faint">
        {anchor.name}
      </p>
      {anchor.inBrew > 0 &&
        onUnbrewOne &&
        item("return one from brew", false, () => onUnbrewOne(anchor.itemKey))}
      {onDiscard && anchor.count > 1 &&
        item("delete one", true, () => onDiscard(anchor.itemKey, 1))}
      {onDiscard &&
        item(
          anchor.count > 1 ? `delete all ×${anchor.count}` : "delete",
          true,
          () => onDiscard(anchor.itemKey, anchor.count),
        )}
    </Popover>
  );
}

// An inventory slot is an item frame in the "inventory" context (DESIGN.md §1):
// a real source, stock-checked. Its art ghosts when copies sit in the brew.
function slotFrameItem(item: InventorySlotItem): FrameItem {
  return {
    key: item.key,
    name: item.name,
    color: item.ing?.color ?? NAMED_GREEN,
    real: true, // an inventory holds real stock
    ing: item.ing,
    perfume: !item.ing, // perfume slots carry no ingredient — render the perfume glyph
  };
}

function Slot({
  item,
  hand,
  canMove,
  showSend,
  canEditInventory,
  onShiftToBrew,
  onUnbrewOne,
  onSend,
  onMenu,
}: {
  item: InventorySlotItem;
  hand: BrewHand;
  canMove: boolean;
  showSend: boolean;
  canEditInventory: boolean;
  onShiftToBrew?: (itemKey: string) => void;
  onUnbrewOne?: (itemKey: string) => void;
  onSend: (a: SendAnchor) => void;
  onMenu: (a: MenuAnchor) => void;
}) {
  const g = grabHandlers({
    itemKey: item.key,
    from: "inventory",
    available: item.count,
    inBrew: item.inBrew,
    hand,
    canMove,
    // shift-teleport targets the brew — meaningless for perfume slots
    onShiftToBrew: item.ing ? onShiftToBrew : undefined,
    onUnbrewOne,
  });
  const ghost = item.inBrew > 0;

  // Right-click opens the context menu (return-one / delete) instead of the
  // grab grammar's bare unbrew — the menu carries that action too (DESIGN §5).
  // While carrying, the hand's own window listener returns one, so skip.
  const handlers = canEditInventory
    ? {
        ...g,
        onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
          e.preventDefault();
          if (hand.hand) return;
          onMenu({
            itemKey: item.key,
            name: item.name,
            count: item.count,
            inBrew: item.inBrew,
            x: e.clientX,
            y: e.clientY,
          });
        },
      }
    : g;

  return (
    <li>
      <ItemFrame
        context="inventory"
        item={slotFrameItem(item)}
        fill
        ghosted={ghost}
        count={item.count}
        handlers={handlers}
        label={`Pick up ${item.name}`}
        title={`${item.name} ×${item.count}${ghost ? ` — ${item.inBrew} in the brew` : ""}${item.provenance ? `\n${item.provenance}` : ""}`}
        disabled={!canMove}
        data-testid="inventory-slot"
      >
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
            <SendGlyph size={11} />
          </button>
        )}
      </ItemFrame>
    </li>
  );
}

// ── send popover ─────────────────────────────────────────────────────────────

function SendPopover({
  anchor,
  members,
  onGift,
  onClose,
}: {
  anchor: SendAnchor;
  members: { memberKey: string; name: string }[];
  onGift: (toMemberKey: string, itemKey: string, n: number) => void;
  onClose: () => void;
}) {
  const [to, setTo] = useState(members[0]?.memberKey ?? "");
  const [n, setN] = useState(1);

  const count = Math.min(Math.max(Math.round(n) || 0, 0), anchor.max);
  const valid = to !== "" && count >= 1;

  return (
    <Popover
      anchor={{ x: anchor.x, y: anchor.y + 6 }}
      align="right"
      width={232}
      label={`Send ${anchor.name}`}
      onClose={onClose}
      className="p-2.5"
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
          <option key={m.memberKey} value={m.memberKey}>
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
            onGift(to, anchor.itemKey, count);
            onClose();
          }}
          className={cn(btn.accent, "ml-auto px-2.5 py-1")}
        >
          Send
        </button>
      </div>
    </Popover>
  );
}
