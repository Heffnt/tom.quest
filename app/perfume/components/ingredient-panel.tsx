"use client";

// The input panel (left drawer — DESIGN.md §Layout). Its slots and cards are
// item FRAMES (components/item-frame.tsx). The tab model is the spec's §Layout
// one, for real:
//
//   Ingredients | Frequencies | <you> | <each other member>…
//
// - Ingredients / Frequencies are the CATALOG tabs: the 96 ingredients + the
//   pure frequencies rendered as an item-frame grid of compact cards (art, name,
//   type glyph, emitted-frequency dots, charge marks). These frames are
//   hypothetical SOURCES (DESIGN.md §1) — dragging out mints a dashed item.
// - One tab per registered member's INVENTORY, the viewer's own FIRST. The
//   viewer's own inventory is a grid of REAL drag sources (the inventory
//   context); every other member's inventory is VISIBLE but NOT a drag source
//   (DESIGN.md §4 matrix), rendered as inert frames, plus the ghosted gift
//   drop-frame at the top (only where gift is permitted — DESIGN.md §Interactions
//   "Gifting", §4).
//
// Every grabbable frame obeys the hand grammar (DESIGN.md §5): pointer-down picks
// up, shift-click teleports one unit to the brew, right-click returns one.
// Header actions: Import (tolerant paste → preview → merge/replace) and Copy (clipboard
// export). Search + the multi-select frequency/type filter narrow the catalog
// grids and the inventory grids alike (AND semantics). Buttons/tabs use the
// shell's shared treatment (components/ui.tsx).

import { useEffect, useMemo, useRef, useState } from "react";
import type { Ingredient, Perfume } from "../lib/types";
import type { Inventory, PerfumeInstance, BrowseUI } from "../lib/brew-types";
import type { BrewHand } from "../lib/use-hand";
import { makeNameResolver, provenanceTooltip, type NameResolver } from "../lib/provenance";
import {
  ALL_FREQUENCIES,
  FUND,
  PERFUME_BY_KEY,
  basePerfumes,
  ingredientWeight,
  isPureKey,
} from "../data/base";
import { formatInventory, type CatalogEntry } from "../lib/inventory";
import { splitFilters, ingredientPasses, ingredientMatchesSearch } from "../lib/filters";
import ItemFrame, { type FrameItem } from "./item-frame";
import FrequencyFilterButton from "./frequency-filter";
import InventoryGrid, {
  grabHandlers,
  type InventorySlotItem,
} from "./inventory-grid";
import ImportDialog from "./import-dialog";
import { btn, tab, cn } from "./ui";

// A member tab entry: the viewer's own is flagged so it renders as REAL drag
// sources and the others render inert + a gift drop-frame.
export type MemberTab = { memberKey: string; name: string; isSelf: boolean };

export interface IngredientPanelProps {
  // ingredients + pures (the 96 + pure frequencies); perfume display names
  // resolve through data/base.
  catalog: Ingredient[];
  // the viewer's own inventory (drives the copy/import + the "you" tab grid)
  inventory: Inventory;
  // any member's inventory, reactively subscribed for the SELECTED tab only
  // (store.inventoryOf); other keys read the last cached projection / empty.
  inventoryOf: (memberKey: string) => Inventory;
  // copies of each catalog key currently in the brew — ghosts icons here
  brewCounts: Record<string, number>;
  ui: BrowseUI;
  onUI: (patch: Partial<BrowseUI>) => void;
  hand: BrewHand;
  // WHERE-move permission (drag inventory ↔ brew). DESIGN.md §4.
  canMove: boolean;
  // owner-scope: may import/copy the viewer's own inventory.
  canEditInventory: boolean;
  // §4 matrix "Gift items": own/party brew yes, another member's brew no. The
  // ghost gift drop-frame renders only where this is true.
  canGift: boolean;
  isAnon: boolean;
  // member inventory tabs, the viewer's own FIRST (DESIGN.md §Layout).
  memberTabs: MemberTab[];
  // registered members, for resolving perfume-instance provenance memberKeys →
  // display names in the perfume-slot hover tooltip (DESIGN.md §1,§9).
  members: { memberKey: string; name: string }[];
  onImport: (rows: { itemKey: string; count: number }[], mode: "merge" | "replace") => void;
  // gift one of the viewer's own items to a member (drag-drop or send popover).
  onGift: (toMemberKey: string, itemKey: string, n: number) => void;
  // point the store's single non-own inventory subscription at a member tab
  // (null when a catalog/own tab is open) — never N subscriptions.
  onSelectMemberTab: (memberKey: string | null) => void;
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

function catalogSort(a: Ingredient, b: Ingredient, frequencies: boolean): number {
  return frequencies
    ? pureRank(a) - pureRank(b) || freqOrder(a) - freqOrder(b)
    : ingredientRank(a) - ingredientRank(b) ||
        ingredientWeight(a) - ingredientWeight(b) ||
        a.name.localeCompare(b.name);
}

// ── filtering ────────────────────────────────────────────────────────────────
// ui.inputFilters mixes frequency ids (plus the strike/wild pseudo-filters)
// with "type:<t>" entries. Semantics per DESIGN.md: every selected frequency
// must match (AND); types OR among themselves, AND with the frequencies. The
// ingredient search + filter grammar (ingredientPasses / ingredientMatchesSearch)
// lives in lib/filters so the input panel and the import dialog share it.

// A perfume passes when SOME recipe contains every selected frequency; type
// filters are ingredient-only, so any type selection hides perfumes.
function perfumePasses(perfume: Perfume | undefined, types: string[], freqs: string[]): boolean {
  if (types.length > 0) return false;
  if (freqs.length === 0) return true;
  if (!perfume) return false;
  return perfume.recipes.some((req) => freqs.every((f) => req.includes(f)));
}

// Perfume search matches name or any recipe (id or school name); the ingredient
// equivalent (ingredientMatchesSearch) lives in lib/filters.
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

// ── the panel ────────────────────────────────────────────────────────────────

export default function IngredientPanel({
  catalog,
  inventory,
  inventoryOf,
  brewCounts,
  ui,
  onUI,
  hand,
  canMove,
  canEditInventory,
  canGift,
  isAnon,
  memberTabs,
  members,
  onImport,
  onGift,
  onSelectMemberTab,
  onShiftToBrew,
  onUnbrewOne,
}: IngredientPanelProps) {
  const [importOpen, setImportOpen] = useState(false);
  const resolveName = useMemo(() => makeNameResolver(members), [members]);
  const [copied, setCopied] = useState(false);
  // The open tab. A catalog tab ("ingredients"/"frequencies") drives ui.inputTab
  // (browse UI); a member tab is a panel-local member-key selection, so
  // the frozen BrowseUI shape stays untouched. They are mutually exclusive. The
  // panel opens on the viewer's OWN inventory tab (the primary workspace) — see
  // the default-selection effect below.
  const [memberTab, setMemberTab] = useState<string | null>(null);
  const defaultedRef = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  // Open on the viewer's own inventory tab once it is known (the primary
  // workspace — the old always-on inventory section). Fires once; the user's
  // subsequent tab choices stand.
  const selfKey = memberTabs.find((m) => m.isSelf)?.memberKey ?? null;
  useEffect(() => {
    if (defaultedRef.current || selfKey === null) return;
    defaultedRef.current = true;
    setMemberTab(selfKey);
  }, [selfKey]);

  // Point the store's single non-own inventory subscription at the selected
  // member tab (never at the viewer's own — that is already subscribed), and
  // drop it when a catalog/own tab is open. Exactly ONE other member is live.
  const selectedOther =
    memberTab !== null && memberTab !== selfKey ? memberTab : null;
  useEffect(() => {
    onSelectMemberTab(selectedOther);
    return () => onSelectMemberTab(null);
  }, [selectedOther, onSelectMemberTab]);

  // A member tab that disappears (member left / list changed) falls back to the
  // Ingredients catalog tab so the panel never strands on a dead tab.
  useEffect(() => {
    if (memberTab !== null && !memberTabs.some((m) => m.memberKey === memberTab)) {
      setMemberTab(null);
    }
  }, [memberTab, memberTabs]);

  const ingByKey = useMemo(() => new Map(catalog.map((i) => [i.key, i])), [catalog]);

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

  // ---- the catalog grid: filtered + sorted for the active catalog tab ----
  const frequenciesTab = ui.inputTab === "frequencies";
  const catalogItems = useMemo(
    () =>
      catalog
        .filter((i) => frequenciesTab === isPureKey(i.key))
        .filter((ing) => ingredientPasses(ing, types, freqs) && ingredientMatchesSearch(ing, q)),
    [catalog, frequenciesTab, types, freqs, q],
  );
  const catalogTotal = useMemo(
    () => catalog.filter((i) => frequenciesTab === isPureKey(i.key)).length,
    [catalog, frequenciesTab],
  );
  const filteredCatalog = useMemo(
    () => [...catalogItems].sort((a, b) => catalogSort(a, b, frequenciesTab)),
    [catalogItems, frequenciesTab],
  );

  // ---- an inventory (own or another member's) → grid sections ----
  const sectionsFor = (inv: Inventory, withBrewGhost: boolean) =>
    inventoryGridSections(inv, ingByKey, PERFUME_BY_KEY, types, freqs, q, {
      brewCounts: withBrewGhost ? brewCounts : null,
      resolveName,
    });

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

  // the member whose inventory the open member tab shows
  const openMember = memberTab
    ? memberTabs.find((m) => m.memberKey === memberTab) ?? null
    : null;
  // other members (not the viewer) — the gift targets for the Send popover
  const giftTargets = useMemo(
    () => memberTabs.filter((m) => !m.isSelf).map((m) => ({ memberKey: m.memberKey, name: m.name })),
    [memberTabs],
  );

  const selectCatalog = (t: "ingredients" | "frequencies") => {
    setMemberTab(null);
    onUI({ inputTab: t });
  };

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      {/* search + the multi frequency/type filter — narrows every grid */}
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

      {/* ── tabs (DESIGN.md §Layout): Ingredients | Frequencies | you | others ── */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        {(["ingredients", "frequencies"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => selectCatalog(t)}
            aria-pressed={memberTab === null && ui.inputTab === t}
            className={cn(tab.base, "text-sm font-semibold")}
          >
            {t === "ingredients" ? "Ingredients" : "Frequencies"}
          </button>
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        {memberTabs.map((m) => (
          <button
            key={m.memberKey}
            type="button"
            onClick={() => setMemberTab(m.memberKey)}
            aria-pressed={memberTab === m.memberKey}
            title={m.isSelf ? "Your inventory" : `${m.name}'s inventory`}
            className={cn(tab.base, "text-sm font-semibold")}
          >
            {m.isSelf ? "You" : m.name}
          </button>
        ))}
      </div>

      {/* data-pf-surface: presence coordinates are content-space of this
          scroll container, so spectators track rows, not pixels */}
      <div data-pf-surface="input" className="min-h-0 flex-1 overflow-y-auto">
        {memberTab !== null ? (
          openMember?.isSelf ? (
            // your own inventory: real drag sources + per-slot Send (gifting)
            <section aria-label="Your inventory">
              <InventoryHeader
                canEditInventory={canEditInventory}
                copied={copied}
                onImport={() => setImportOpen(true)}
                onCopy={copy}
              />
              {isAnon && <AnonNote />}
              <InventoryGrid
                sections={sectionsFor(inventory, true)}
                hand={hand}
                canMove={canMove}
                canGift={canGift}
                members={giftTargets}
                onGift={onGift}
                onShiftToBrew={onShiftToBrew}
                onUnbrewOne={onUnbrewOne}
              />
            </section>
          ) : openMember ? (
            // another member's inventory: VISIBLE, not a drag source (§4), plus
            // the ghosted gift drop-frame when gifting is permitted.
            <MemberInventoryTab
              member={openMember}
              sections={sectionsFor(inventoryOf(openMember.memberKey), false)}
              hand={hand}
              canGift={canGift}
              onGift={onGift}
            />
          ) : null
        ) : (
          // a catalog tab: the hypothetical-source item-frame grid
          <section aria-label="Catalog">
            <div className="flex items-center justify-end px-3 py-1.5">
              <span className="font-mono text-xs tabular-nums text-text-faint">
                {filteredCatalog.length}/{catalogTotal}
              </span>
            </div>
            {filteredCatalog.length === 0 ? (
              <p className="px-4 py-6 text-center font-mono text-xs text-text-faint">
                {frequenciesTab ? "no frequencies match" : "no ingredients match"}
              </p>
            ) : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-1.5 px-3 pb-3">
                {filteredCatalog.map((ing) => (
                  <CatalogCard
                    key={ing.key}
                    ing={ing}
                    owned={ownedOf(inventory, ing.key)}
                    inBrew={brewCounts[ing.key] ?? 0}
                    hand={hand}
                    canMove={canMove}
                    onShiftToBrew={onShiftToBrew}
                    onUnbrewOne={onUnbrewOne}
                  />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      {importOpen && (
        <ImportDialog
          catalog={nameCatalog}
          ingredients={catalog}
          onImport={onImport}
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  );
}

// ── the inventory header (import / copy) ─────────────────────────────────────

function InventoryHeader({
  canEditInventory,
  copied,
  onImport,
  onCopy,
}: {
  canEditInventory: boolean;
  copied: boolean;
  onImport: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
      <h2 className="text-sm font-semibold text-text-muted">Inventory</h2>
      <div className="flex items-center gap-1.5">
        {canEditInventory && (
          <button
            type="button"
            onClick={onImport}
            title="Paste an inventory as text"
            className={btn.outline}
          >
            import
          </button>
        )}
        <button
          type="button"
          onClick={onCopy}
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
  );
}

function AnonNote() {
  return (
    <p className="mx-3 mt-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-snug text-warning">
      Anonymous brew — it&apos;s keyed to this browser&apos;s storage and won&apos;t
      follow you elsewhere. Sign in to keep it.
    </p>
  );
}

// ── another member's inventory tab (visible, not a drag source; §4) ──────────
// The member's stacks render as inert item frames (no hand handlers → not
// grabbable). When gifting is permitted a ghosted gift drop-frame sits on top:
// drop one of YOUR items on it (drag-release or, while holding a stack, click)
// and it gifts instantly to this member (DESIGN.md §Interactions "Gifting").

function MemberInventoryTab({
  member,
  sections,
  hand,
  canGift,
  onGift,
}: {
  member: MemberTab;
  sections: InventoryGridSection[];
  hand: BrewHand;
  canGift: boolean;
  onGift: (toMemberKey: string, itemKey: string, n: number) => void;
}) {
  const held = hand.hand;
  // only your OWN items gift — a held cauldron perfume is not a gift source
  const giftable = canGift && !!held && held.from !== "output";
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
    <section aria-label={`${member.name}'s inventory`}>
      {canGift && (
        <div className="flex flex-col items-center gap-2 border-b border-border/60 px-4 py-4">
          <ItemFrame
            context="gift"
            item={null}
            ghostPreview={preview}
            label={`Gift to ${member.name}`}
            handlers={{
              onClick: () => {
                if (giftable && held) {
                  onGift(member.memberKey, held.itemKey, held.count);
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
      )}
      <p className="px-3 pt-2 font-mono text-[10px] uppercase tracking-wider text-text-faint">
        {member.name}&apos;s inventory · view only
      </p>
      <ReadOnlyInventory sections={sections} />
    </section>
  );
}

// A member's inventory shown read-only: the same three sections as InventoryGrid
// but each slot is an inert item frame (no handlers), so it is visible but never
// a drag source (DESIGN.md §4 matrix).
function ReadOnlyInventory({ sections }: { sections: InventoryGridSection[] }) {
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
                <li key={item.key}>
                  <ItemFrame
                    context="inventory"
                    item={{
                      key: item.key,
                      name: item.name,
                      color: item.ing?.color ?? "#6FE3C4",
                      real: true,
                      ing: item.ing,
                      perfume: !item.ing,
                    }}
                    fill
                    count={item.count}
                    title={`${item.name} ×${item.count}${item.provenance ? `\n${item.provenance}` : ""}`}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

// ── the catalog card (a hypothetical-source item frame) ──────────────────────
// The Ingredients/Frequencies grid entry (DESIGN.md §Layout "compact card"): the
// item art on the rounded square, its name, and the compact marks (type glyph +
// emitted-frequency dots + charge marks) via ItemFrame's showMarks. The whole
// card is a grab target; the catalog is a boundless hypothetical source, so the
// minted item is dashed and beyond stock the brew keeps it hypothetical.

function CatalogCard({
  ing,
  owned,
  inBrew,
  hand,
  canMove,
  onShiftToBrew,
  onUnbrewOne,
}: {
  ing: Ingredient;
  owned: number;
  inBrew: number;
  hand: BrewHand;
  canMove: boolean;
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
    onShiftToBrew,
    onUnbrewOne,
  });
  const art: FrameItem = { key: ing.key, name: ing.name, color: ing.color, real: false, ing };
  const ghost = inBrew > 0;

  return (
    <li>
      <ItemFrame
        context="catalog"
        item={art}
        fill
        size={34}
        showMarks
        name={ing.name}
        ghosted={ghost}
        count={owned}
        handlers={g}
        label={`Pick up ${ing.name}`}
        title={
          canMove
            ? `${ing.name} — click to pick up (again for +1); shift-click sends one to the brew; right-click puts one back`
            : ing.name
        }
        disabled={!canMove}
        className={ghost ? "bg-amber-400/10" : undefined}
        data-testid="catalog-row"
      >
        {inBrew > 0 && (
          <span
            className="pointer-events-none absolute -top-1 left-0.5 rounded bg-amber-400/20 px-1 font-mono text-[9px] font-bold leading-4 tabular-nums text-amber-400"
            title={`${inBrew} in the brew`}
          >
            ×{inBrew}
          </span>
        )}
      </ItemFrame>
    </li>
  );
}

// ── inventory → grid sections (shared by the own tab and read-only tabs) ─────

export type InventoryGridSection = {
  id: keyof Inventory;
  label: string;
  items: InventorySlotItem[];
  owned: number;
};

function ownedOf(inv: Inventory, itemKey: string): number {
  if (isPureKey(itemKey)) return inv.pures[itemKey] ?? 0;
  return inv.ingredients[itemKey] ?? 0;
}

// Build the three inventory sections (ingredients / pures / perfumes) filtered
// and sorted. When brewCounts is passed, a fully-brewed stack keeps its slot
// (ghosted, inBrew set) — the viewer's own tab wants that; a read-only tab does
// not (it shows only what that member still holds).
function inventoryGridSections(
  inv: Inventory,
  ingByKey: Map<string, Ingredient>,
  perfumeByKey: Map<string, Perfume>,
  types: string[],
  freqs: string[],
  q: string,
  opts: { brewCounts: Record<string, number> | null; resolveName: NameResolver },
): InventoryGridSection[] {
  const brewCounts = opts.brewCounts;
  const itemSlots = (section: "ingredients" | "pures") => {
    const keys = new Set(Object.keys(inv[section]));
    if (brewCounts) {
      for (const [k, n] of Object.entries(brewCounts)) {
        if (n > 0 && (section === "pures") === isPureKey(k)) keys.add(k);
      }
    }
    const items: InventorySlotItem[] = [];
    for (const key of keys) {
      const ing = ingByKey.get(key);
      if (!ing) continue;
      if (!ingredientPasses(ing, types, freqs) || !ingredientMatchesSearch(ing, q)) continue;
      items.push({
        key,
        name: ing.name,
        count: inv[section][key] ?? 0,
        inBrew: brewCounts?.[key] ?? 0,
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

  // most-recent held instance per perfumeId — its provenance is the slot's
  // hover copy (the ×n badge conveys the rest). DESIGN.md §1,§9.
  const latestInstance = new Map<string, PerfumeInstance>();
  for (const inst of inv.perfumeInstances) {
    const prev = latestInstance.get(inst.perfumeId);
    if (!prev || inst.brewedAt > prev.brewedAt) latestInstance.set(inst.perfumeId, inst);
  }
  const perfumeItems: InventorySlotItem[] = Object.entries(inv.perfumes)
    .filter(([, n]) => n > 0)
    .map(([key, count]) => {
      const inst = latestInstance.get(key);
      return {
        key,
        name: perfumeByKey.get(key)?.name ?? key,
        count,
        inBrew: 0,
        provenance: inst
          ? provenanceTooltip(
              { brewedByKey: inst.brewedByKey, witnesses: inst.witnesses, brewedAt: inst.brewedAt, chain: inst.owners },
              opts.resolveName,
            )
          : undefined,
      };
    })
    .filter(
      (item) =>
        perfumePasses(perfumeByKey.get(item.key), types, freqs) &&
        perfumeMatchesSearch(perfumeByKey.get(item.key), item.name, q),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const units = (rec: Record<string, number>) =>
    Object.values(rec).reduce((s, n) => s + n, 0);

  return [
    { id: "ingredients", label: "ingredients", items: itemSlots("ingredients"), owned: units(inv.ingredients) },
    { id: "pures", label: "pure frequencies", items: itemSlots("pures"), owned: units(inv.pures) },
    { id: "perfumes", label: "perfumes", items: perfumeItems, owned: units(inv.perfumes) },
  ];
}

// ── small key helpers ────────────────────────────────────────────────────────

function isIngredientKeyLocal(key: string): boolean {
  return key.startsWith("base:") || key.startsWith("pure:");
}
function itemNameOf(key: string): string {
  return key.replace(/^(base|pure):/, "");
}
