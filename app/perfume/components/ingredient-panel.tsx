"use client";

// The input panel (left drawer — DESIGN.md §Layout). Its slots and cards are
// item FRAMES (components/item-frame.tsx): the viewer's INVENTORY as a grid of
// frames on top — three auto-growing sections — and the full CATALOG (96
// ingredients + pures, an Ingredients / Frequencies tab pair) as rows below,
// then one gift tab per other member (drop-to-gift affordance). Every frame is
// grabbable per the hand grammar (DESIGN.md §5): pointer-down picks up (the hand
// handles drag + the boundary rule), shift-click teleports one unit to the brew,
// right-click returns one; hover only reports the hovered key — the brew bar
// renders the preview, never the graph. Header actions: Import (tolerant paste
// -> preview -> merge/replace) and Copy (clipboard export), plus per-slot Send —
// both owner-only. Search and the multi-select frequency/type filter narrow BOTH
// the grid and the catalog (AND semantics). Buttons/tabs use the shell's shared
// treatment (components/ui.tsx).
//
// The prop CONTRACT (IngredientPanelProps) is the legacy shape the orchestrator
// still passes through lib/legacy-adapter — kept stable while the internals are
// rebuilt onto item frames. The per-member INVENTORY listing (DESIGN.md §Layout
// "one tab per member inventory") awaits the shell passing store.inventoryOf;
// today the member tabs surface the gift target only. See integration notes.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Ingredient, Perfume } from "../lib/types";
import type {
  BenchPermissions,
  Inventory,
  SharedUI,
} from "../lib/legacy-adapter";
import type { BenchHand } from "../lib/use-hand";
import {
  ALL_FREQUENCIES,
  FUND,
  basePerfumes,
  ingredientWeight,
  isPureKey,
} from "../data/base";
import { formatInventory, getCount, type CatalogEntry } from "../lib/inventory";
import { ChargeSymbol, FrequencySymbol, TypeGlyph } from "../lib/frequencies";
import ItemFrame, { ItemArt, FrameCountBadge, type FrameItem } from "./item-frame";
import FrequencyFilterButton from "./frequency-filter";
import InventoryGrid, {
  grabHandlers,
  type InventorySlotItem,
} from "./inventory-grid";
import ImportDialog from "./import-dialog";
import { btn, tab, cn } from "./ui";

export interface IngredientPanelProps {
  // ingredients + pures (the 96 + pure frequencies); perfume display names
  // resolve through data/base.
  catalog: Ingredient[];
  inventory: Inventory;
  // copies of each catalog key currently in the brew — ghosts icons here
  brewCounts: Record<string, number>;
  ui: SharedUI;
  onUI: (patch: Partial<SharedUI>) => void;
  hand: BenchHand;
  permissions: BenchPermissions;
  isAnon: boolean;
  members: { benchKey: string; name: string }[];
  onImport: (rows: { itemKey: string; count: number }[], mode: "merge" | "replace") => void;
  onTransfer: (toBenchKey: string, itemKey: string, n: number) => void;
  // hover reporting only — the client decides what previews where
  onHover: (itemKey: string | null) => void;
  // DESIGN teleports HandApi cannot express: shift-click sends one unit
  // input -> brew; right-click with an empty hand on an in-brew item returns
  // one unit brew -> inventory. Wire to moveToBrew / moveToInventory, n=1.
  onShiftToBrew?: (itemKey: string) => void;
  onUnbrewOne?: (itemKey: string) => void;
}

// ── ordering (unchanged from the stepper-era panel) ──────────────────────────
// Frequencies-tab order: pure strike/wild first, then everything by WEIGHT
// (ALL_FREQUENCIES is already weight-ordered). Ingredients-tab order: emitters
// lightest-first; the ⊖/⊕ charge carriers sort to the very end.
const FREQ_INDEX = new Map(ALL_FREQUENCIES.map((t, i) => [t.id, i]));
function pureRank(ing: Ingredient): number {
  return ing.strike > 0 || ing.wild > 0 ? 0 : 1;
}
function freqOrder(ing: Ingredient): number {
  return FREQ_INDEX.get(ing.key.slice(5)) ?? 99;
}
function ingredientRank(ing: Ingredient): number {
  return ing.strike > 0 || ing.wild > 0 ? 1 : 0;
}

// ── filtering ────────────────────────────────────────────────────────────────
// ui.inputFilters mixes frequency ids (plus the strike/wild pseudo-filters)
// with "type:<t>" entries. Semantics per DESIGN.md: every selected frequency
// must match (AND); types OR among themselves, AND with the frequencies.

function splitFilters(values: string[]): { types: string[]; freqs: string[] } {
  const types: string[] = [];
  const freqs: string[] = [];
  for (const v of values) {
    if (v.startsWith("type:")) types.push(v.slice(5));
    else freqs.push(v);
  }
  return { types, freqs };
}

function ingredientPasses(ing: Ingredient, types: string[], freqs: string[]): boolean {
  if (types.length > 0 && (!ing.type || !types.includes(ing.type))) return false;
  return freqs.every((f) =>
    f === "strike" ? ing.strike > 0 : f === "wild" ? ing.wild > 0 : ing.emits.includes(f),
  );
}

// A perfume passes when SOME recipe contains every selected frequency; type
// filters are ingredient-only, so any type selection hides perfumes.
function perfumePasses(perfume: Perfume | undefined, types: string[], freqs: string[]): boolean {
  if (types.length > 0) return false;
  if (freqs.length === 0) return true;
  if (!perfume) return false;
  return perfume.recipes.some((req) => freqs.every((f) => req.includes(f)));
}

// Search matches names or any emitted frequency (id or school name — e.g.
// "transmutation" finds every T-emitter); perfumes match name or any recipe.
function ingredientMatchesSearch(ing: Ingredient, q: string): boolean {
  if (!q) return true;
  if (ing.name.toLowerCase().includes(q)) return true;
  if (ing.emits.some((t) => t.toLowerCase().includes(q))) return true;
  return ing.emits.some((t) => (FUND[t]?.school ?? "").toLowerCase().includes(q));
}

function perfumeMatchesSearch(perfume: Perfume | undefined, name: string, q: string): boolean {
  if (!q) return true;
  if (name.toLowerCase().includes(q)) return true;
  if (!perfume) return false;
  return perfume.recipes.some((req) =>
    req.some(
      (id) => id.toLowerCase().includes(q) || (FUND[id]?.school ?? "").toLowerCase().includes(q),
    ),
  );
}

export default function IngredientPanel({
  catalog,
  inventory,
  brewCounts,
  ui,
  onUI,
  hand,
  permissions,
  isAnon,
  members,
  onImport,
  onTransfer,
  onHover,
  onShiftToBrew,
  onUnbrewOne,
}: IngredientPanelProps) {
  const [importOpen, setImportOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Which catalog/member tab is showing (DESIGN.md §Layout). The Ingredients /
  // Frequencies catalog tabs stay driven by ui.inputTab (shared browse UI); a
  // per-member gift tab is a panel-local selection ("member:<key>"), so the
  // frozen SharedUI shape stays untouched. Selecting a member tab surfaces that
  // member's drop-to-gift affordance (DESIGN.md §Interactions "Gifting").
  const [memberTab, setMemberTab] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const ingByKey = useMemo(() => new Map(catalog.map((i) => [i.key, i])), [catalog]);
  const perfumeByKey = useMemo(() => new Map(basePerfumes.map((p) => [p.key, p])), []);

  // names the importer/exporter can resolve: the item catalog + perfumes
  const nameCatalog = useMemo<CatalogEntry[]>(
    () => [
      ...catalog.map(({ key, name }) => ({ key, name })),
      ...basePerfumes.map(({ key, name }) => ({ key, name })),
    ],
    [catalog],
  );

  const q = ui.inputSearch.trim().toLowerCase();
  const { types, freqs } = useMemo(() => splitFilters(ui.inputFilters), [ui.inputFilters]);

  // ---- the grid: inventory ∪ in-brew keys, so a fully-brewed stack keeps its
  // slot (ghosted icon, no badge — "you took the icon") ----
  const gridSections = useMemo(() => {
    const itemSlots = (section: "ingredients" | "pures") => {
      const keys = new Set(Object.keys(inventory[section]));
      for (const [k, n] of Object.entries(brewCounts)) {
        if (n > 0 && (section === "pures") === isPureKey(k)) keys.add(k);
      }
      const items: InventorySlotItem[] = [];
      for (const key of keys) {
        const ing = ingByKey.get(key);
        if (!ing) continue;
        if (!ingredientPasses(ing, types, freqs) || !ingredientMatchesSearch(ing, q)) continue;
        items.push({
          key,
          name: ing.name,
          count: inventory[section][key] ?? 0,
          inBrew: brewCounts[key] ?? 0,
          ing,
        });
      }
      items.sort((a, b) =>
        section === "pures"
          ? pureRank(a.ing!) - pureRank(b.ing!) || freqOrder(a.ing!) - freqOrder(b.ing!)
          : ingredientRank(a.ing!) - ingredientRank(b.ing!) ||
            ingredientWeight(a.ing!) - ingredientWeight(b.ing!) ||
            a.name.localeCompare(b.name),
      );
      return items;
    };

    const perfumeItems: InventorySlotItem[] = Object.entries(inventory.perfumes)
      .filter(([, n]) => n > 0)
      .map(([key, count]) => ({
        key,
        name: perfumeByKey.get(key)?.name ?? key,
        count,
        inBrew: 0,
      }))
      .filter(
        (item) =>
          perfumePasses(perfumeByKey.get(item.key), types, freqs) &&
          perfumeMatchesSearch(perfumeByKey.get(item.key), item.name, q),
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    const units = (rec: Record<string, number>) =>
      Object.values(rec).reduce((s, n) => s + n, 0);

    return [
      {
        id: "ingredients" as const,
        label: "ingredients",
        items: itemSlots("ingredients"),
        owned: units(inventory.ingredients),
      },
      {
        id: "pures" as const,
        label: "pure frequencies",
        items: itemSlots("pures"),
        owned: units(inventory.pures),
      },
      {
        id: "perfumes" as const,
        label: "perfumes",
        items: perfumeItems,
        owned: units(inventory.perfumes),
      },
    ];
  }, [inventory, brewCounts, ingByKey, perfumeByKey, types, freqs, q]);

  // ---- the catalog ----
  const tabItems = useMemo(
    () => catalog.filter((i) => (ui.inputTab === "frequencies") === isPureKey(i.key)),
    [catalog, ui.inputTab],
  );

  const filtered = useMemo(
    () =>
      tabItems
        .filter((ing) => ingredientPasses(ing, types, freqs) && ingredientMatchesSearch(ing, q))
        .sort((a, b) =>
          ui.inputTab === "frequencies"
            ? pureRank(a) - pureRank(b) || freqOrder(a) - freqOrder(b)
            : ingredientRank(a) - ingredientRank(b) ||
              ingredientWeight(a) - ingredientWeight(b) ||
              a.name.localeCompare(b.name),
        ),
    [tabItems, types, freqs, q, ui.inputTab],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatInventory(inventory, nameCatalog));
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (permissions / insecure context): no confirmation
    }
  };

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      {/* search + the multi frequency/type filter — narrows grid AND catalog */}
      <div className="border-b border-border p-3">
        <div className="flex items-stretch gap-2">
          <input
            value={ui.inputSearch}
            onChange={(e) => onUI({ inputSearch: e.target.value })}
            placeholder="search ingredients, frequencies, perfumes…"
            spellCheck={false}
            className="w-full min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
          />
          <FrequencyFilterButton
            values={ui.inputFilters}
            onChange={(values) => onUI({ inputFilters: values })}
            includeCharges
            includeTypes
          />
        </div>
      </div>

      {/* data-pf-surface: presence coordinates are content-space of this
          scroll container, so spectators track rows, not pixels */}
      <div data-pf-surface="input" className="min-h-0 flex-1 overflow-y-auto">
        {/* ── inventory ── */}
        <section aria-label="Inventory">
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <h2 className="text-sm font-semibold text-text-muted">Inventory</h2>
            <div className="flex items-center gap-1.5">
              {permissions.editInventory && (
                <button
                  type="button"
                  onClick={() => setImportOpen(true)}
                  title="Paste an inventory as text"
                  className={btn.outline}
                >
                  import
                </button>
              )}
              <button
                type="button"
                onClick={copy}
                title="Copy the inventory as text"
                className={cn(
                  btn.outline,
                  copied && "border-success/60 text-success hover:border-success/60 hover:text-success",
                )}
              >
                {copied ? "copied ✓" : "copy"}
              </button>
            </div>
          </div>
          {isAnon && (
            <p className="mx-3 mt-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-snug text-warning">
              Anonymous bench — it&apos;s keyed to this browser&apos;s storage and won&apos;t
              follow you elsewhere. Sign in to keep it.
            </p>
          )}
          <InventoryGrid
            sections={gridSections}
            hand={hand}
            canMove={permissions.moveItems}
            canTransfer={permissions.editInventory}
            members={members}
            onHover={onHover}
            onTransfer={onTransfer}
            onShiftToBrew={onShiftToBrew}
            onUnbrewOne={onUnbrewOne}
          />
        </section>

        {/* ── catalog + member gift tabs (DESIGN.md §Layout) ── */}
        <section aria-label="Catalog" className="border-t border-border">
          <div className="flex items-center justify-between px-3 py-2">
            <div className="flex flex-wrap items-center gap-1">
              {(["ingredients", "frequencies"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setMemberTab(null);
                    onUI({ inputTab: t });
                  }}
                  aria-pressed={memberTab === null && ui.inputTab === t}
                  className={cn(tab.base, "text-sm font-semibold")}
                >
                  {t === "ingredients" ? "Ingredients" : "Frequencies"}
                </button>
              ))}
              {/* one gift tab per other member (own inventory is the grid
                  above; per-member inventory listings await the shell passing
                  inventoryOf — see integration notes). */}
              {permissions.editInventory &&
                members.map((m) => (
                  <button
                    key={m.benchKey}
                    type="button"
                    onClick={() => setMemberTab((cur) => (cur === m.benchKey ? null : m.benchKey))}
                    aria-pressed={memberTab === m.benchKey}
                    title={`Gift to ${m.name}`}
                    className={cn(tab.base, "text-sm font-semibold")}
                  >
                    {m.name}
                  </button>
                ))}
            </div>
            {memberTab === null && (
              <span className="font-mono text-xs tabular-nums text-text-faint">
                {filtered.length}/{tabItems.length}
              </span>
            )}
          </div>

          {memberTab !== null ? (
            <MemberGiftTab
              member={members.find((m) => m.benchKey === memberTab) ?? null}
              hand={hand}
              onTransfer={onTransfer}
            />
          ) : filtered.length === 0 ? (
            <p className="px-4 py-6 text-center font-mono text-xs text-text-faint">
              {ui.inputTab === "ingredients" ? "no ingredients match" : "no frequencies match"}
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {filtered.map((ing) => (
                <CatalogRow
                  key={ing.key}
                  ing={ing}
                  owned={getCount(inventory, ing.key)}
                  inBrew={brewCounts[ing.key] ?? 0}
                  hand={hand}
                  canMove={permissions.moveItems}
                  onHover={onHover}
                  onShiftToBrew={onShiftToBrew}
                  onUnbrewOne={onUnbrewOne}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {importOpen && (
        <ImportDialog catalog={nameCatalog} onImport={onImport} onClose={() => setImportOpen(false)} />
      )}
    </div>
  );
}

// ── member gift tab (DESIGN.md §Interactions "Gifting") ──────────────────────
// A member's tab shows a ghosted item-frame drop-to-gift affordance. Drop one
// of your items here (drag-release or, while holding a stack, click) and it
// gifts instantly to that member via onTransfer -> store.giftItem. The frame
// previews the held item so the target reads as "release to gift this".
//
// NOTE (integrator): this surfaces the gift target only. Listing the member's
// OWN inventory as item frames (per DESIGN.md §Layout "one tab per member
// inventory") needs the shell to pass a per-member inventory (store.inventoryOf)
// — the panel's current props carry only the viewer's own inventory. See the
// integration notes.
function MemberGiftTab({
  member,
  hand,
  onTransfer,
}: {
  member: { benchKey: string; name: string } | null;
  hand: BenchHand;
  onTransfer: (toBenchKey: string, itemKey: string, n: number) => void;
}) {
  if (!member) return null;
  const held = hand.hand;
  // only your OWN items gift — the held stack must not be an output phial
  const giftable = held && held.from !== "output";
  const preview: FrameItem | null =
    giftable && held
      ? {
          key: held.itemKey,
          name: itemNameOf(held.itemKey),
          color: "#6FE3C4",
          real: false,
          perfume: !isIngredientKeyLocal(held.itemKey),
        }
      : null;

  return (
    <div className="flex flex-col items-center gap-2 px-4 py-6">
      <ItemFrame
        context="gift"
        item={null}
        ghostPreview={preview}
        label={`Gift to ${member.name}`}
        handlers={{
          onClick: () => {
            if (giftable && held) {
              onTransfer(member.benchKey, held.itemKey, held.count);
              hand.settle();
            }
          },
        }}
        data-testid="gift-target"
      />
      <p className="text-center font-mono text-[11px] leading-snug text-text-faint">
        {giftable
          ? `Release to gift to ${member.name}`
          : `Pick up one of your items, then drop it here to gift it to ${member.name}.`}
      </p>
    </div>
  );
}

function isIngredientKeyLocal(key: string): boolean {
  return key.startsWith("base:") || key.startsWith("pure:");
}
function itemNameOf(key: string): string {
  return key.replace(/^(base|pure):/, "");
}

// ── catalog rows ─────────────────────────────────────────────────────────────
// The stepper-era visuals, minus the −/count/+ cluster and the add/remove-all
// click toggle: the whole row body is a grab target. In-brew rows keep the
// amber ring, ghost their icon, and show the in-brew count.

const IN_BREW_ROW =
  "border-l-2 border-amber-400 bg-amber-400/10 ring-1 ring-inset ring-amber-400/50 hover:bg-amber-400/15";
const OUT_ROW = "border-l-2 border-transparent hover:bg-surface-alt";

function CatalogRow({
  ing,
  owned,
  inBrew,
  hand,
  canMove,
  onHover,
  onShiftToBrew,
  onUnbrewOne,
}: {
  ing: Ingredient;
  owned: number;
  inBrew: number;
  hand: BenchHand;
  canMove: boolean;
  onHover: (itemKey: string | null) => void;
  onShiftToBrew?: (itemKey: string) => void;
  onUnbrewOne?: (itemKey: string) => void;
}) {
  const g = grabHandlers({
    itemKey: ing.key,
    from: "catalog",
    // the catalog is boundless — beyond stock the brew marks hypotheticals
    available: Number.POSITIVE_INFINITY,
    inBrew,
    hand,
    canMove,
    onHover,
    onShiftToBrew,
    onUnbrewOne,
  });
  const pure = isPureKey(ing.key);
  const inert = ing.emits.length === 0 && !ing.strike && !ing.wild;
  // the catalog is a hypothetical SOURCE (DESIGN.md §1) — its leading art is the
  // one item-art (item-frame's ItemArt), the same square that fills the frames.
  const art: FrameItem = { key: ing.key, name: ing.name, color: ing.color, real: false, ing };

  return (
    <li
      data-testid="catalog-row"
      data-item-key={ing.key}
      className={`group flex items-center gap-2 px-4 ${pure ? "py-2" : "py-2.5"} transition-colors ${
        inBrew > 0 ? IN_BREW_ROW : OUT_ROW
      }`}
    >
      <button
        type="button"
        {...g}
        aria-label={`Pick up ${ing.name}`}
        aria-disabled={!canMove || undefined}
        title={
          canMove
            ? `${ing.name} — click to pick up (again for +1); shift-click sends one to the brew; right-click puts one back`
            : ing.name
        }
        className="flex min-w-0 flex-1 touch-none select-none items-center gap-2.5 text-left"
      >
        <span className="relative shrink-0">
          <span
            className={`inline-flex transition-opacity duration-150 ${inBrew > 0 ? "opacity-35" : ""}`}
          >
            <ItemArt item={art} size={pure ? 30 : 42} />
          </span>
          {owned > 0 && <FrameCountBadge n={owned} className="absolute -bottom-1 -right-1" />}
        </span>
        {!pure && ing.type && <TypeGlyph type={ing.type} size={20} />}
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-text">
          {ing.name}
        </span>
        {!pure && (
          <span className="flex shrink-0 items-center gap-1">
            {ing.emits.map((t, i) => (
              <FrequencySymbol key={`${t}:${i}`} id={t} size={21} />
            ))}
            {Array.from({ length: ing.strike }, (_, i) => (
              <ChargeSymbol key={`s${i}`} kind="strike" size={21} />
            ))}
            {Array.from({ length: ing.wild }, (_, i) => (
              <ChargeSymbol key={`w${i}`} kind="wild" size={21} />
            ))}
            {inert && <span className="font-mono text-[10px] text-text-faint">inert</span>}
          </span>
        )}
        {inBrew > 0 && (
          <span
            className="shrink-0 font-mono text-sm font-bold tabular-nums text-amber-400"
            title={`${inBrew} in the brew`}
          >
            ×{inBrew}
          </span>
        )}
      </button>
    </li>
  );
}
