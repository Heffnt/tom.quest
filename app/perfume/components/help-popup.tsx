"use client";

// The HELP POPUP (DESIGN.md §6 "Help popup"). A "?" affordance in a corner of
// the always-on brew stage that opens the first-brew guide. It replaces the old
// gear "How it works" details block: the gear now holds only mute + membership.
//
// Three layers, top to bottom (DESIGN.md §6):
//   (a) a condensed LEGEND strip — the REAL glyphs/mini-frames, not bespoke art
//       (tan/grey item frames, ghost circle, frequency circle, purple strike
//       cover, cauldron-tint swatch);
//   (b) the ten-card first-brew WALKTHROUGH — each card illustrated with the
//       same real components the stage draws (ItemFrame, FrequencyGlyph,
//       PerfumeGlyph, charge/send glyphs);
//   (c) the RULES list.
//
// Copy is verbatim from DESIGN.md §6 / the UX suite. On a wide viewport the
// content rides the shared Popover anchored off the "?"; on a narrow viewport it
// becomes a full-screen sheet. Both are scrollable, dismiss on outside-click /
// Escape / the close button, and add no motion that prefers-reduced-motion would
// object to (the panel simply appears; the one fade is motion-safe only).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Popover, useDismissable, type PopoverAnchor } from "./popover";
import { btn, cn } from "./ui";
import ItemFrame, { type FrameItem } from "./item-frame";
import { FrequencyGlyph, ChargeSymbol, STRIKE, NAMED_GREEN } from "../lib/frequencies";
import { PerfumeGlyph } from "./perfume-glyph";
import { SendGlyph } from "./glyphs";
import { blendTint } from "../lib/brew-graph-layout";

// ── real-component sample items (never bespoke art) ───────────────────────────
// A concrete ingredient so the mini frames render the same crest art an
// inventory slot would. Only the tan/grey ground differs (real vs hypothetical).
const SAMPLE_REAL: FrameItem = {
  key: "base:Ichorberries",
  name: "Ichorberries",
  color: "#7cb46b",
  real: true,
};
const SAMPLE_HYPO: FrameItem = { ...SAMPLE_REAL, real: false };

// A representative cauldron tint (the same blend logic the vessel liquid uses).
const CAULDRON_TINT = blendTint({ A: 1, C: 1, N: 1 });

// ── small real-glyph atoms reused across legend + walkthrough ─────────────────

/** A compact real item frame (icon-only, no caption), tan or grey. */
function MiniItem({ real }: { real: boolean }) {
  return (
    <ItemFrame context="brew" item={real ? SAMPLE_REAL : SAMPLE_HYPO} size={20} />
  );
}

/** A frequency circle, exactly as the graph draws one. */
function FreqCircle({ id = "A", size = 30 }: { id?: string; size?: number }) {
  return <FrequencyGlyph id={id} size={size} />;
}

/** A ghost frequency — the same dashed, faded circle the pin renders. */
function GhostCircle({ id = "Ignetium", size = 30 }: { id?: string; size?: number }) {
  return (
    <span className="rounded-full opacity-40" style={{ filter: "grayscale(0.4)" }}>
      <FrequencyGlyph id={id} size={size} className="border-dashed" />
    </span>
  );
}

/** A struck frequency — the real purple cover laid over a circle (DESIGN.md §1). */
function StruckCircle({ id = "A", size = 30 }: { id?: string; size?: number }) {
  return (
    <span className="relative inline-flex">
      <FrequencyGlyph id={id} size={size} />
      <span
        className="pointer-events-none absolute inset-0 grid place-items-center rounded-full"
        style={{ background: `${STRIKE}cc`, boxShadow: `inset 0 0 0 2px ${STRIKE}` }}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} aria-hidden="true">
          <path d="M4 12h16" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      </span>
    </span>
  );
}

/** The cauldron-tint swatch — a droplet washed in the brew's blend colour. */
function TintSwatch({ size = 28 }: { size?: number }) {
  return (
    <span className="relative grid place-items-center" style={{ width: size, height: size }}>
      <span
        className="pointer-events-none absolute inset-0 rounded-full blur-[5px]"
        style={{ background: CAULDRON_TINT, opacity: 0.5 }}
        aria-hidden="true"
      />
      <span
        className="relative rounded-full border border-border"
        style={{
          width: size,
          height: size,
          background: `radial-gradient(circle at 40% 32%, ${CAULDRON_TINT}, ${CAULDRON_TINT}99)`,
        }}
      />
    </span>
  );
}

/** A tinted perfume silhouette — the real cauldron/inventory glyph. */
function PerfumeSwatch({ size = 34 }: { size?: number }) {
  return (
    <span className="relative grid place-items-center" style={{ color: NAMED_GREEN }}>
      <span
        className="pointer-events-none absolute inset-0 rounded-full blur-[6px]"
        style={{ background: NAMED_GREEN, opacity: 0.45 }}
        aria-hidden="true"
      />
      <span className="relative">
        <PerfumeGlyph size={size} />
      </span>
    </span>
  );
}

function Arrow() {
  return (
    <span aria-hidden="true" className="px-0.5 font-mono text-sm text-text-faint">
      →
    </span>
  );
}

/** A colour dot standing for a member's presence colour. */
function MemberDot() {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-4 rounded-full border border-border"
      style={{ background: NAMED_GREEN }}
    />
  );
}

// ── condensed legend (layer a) ────────────────────────────────────────────────
// Verbatim copy; each entry pairs the REAL glyph with its plain-language gloss.

const LEGEND: { glyph: React.ReactNode; text: string }[] = [
  { glyph: <MiniItem real />, text: "tan square = real (backed by stock)" },
  { glyph: <MiniItem real={false} />, text: "grey square = hypothetical (a plan)" },
  { glyph: <GhostCircle />, text: "dashed circle = ghost (a frequency the pin still needs)" },
  { glyph: <MiniItem real />, text: "square = draggable item" },
  { glyph: <FreqCircle />, text: "circle = a frequency in the graph" },
  { glyph: <StruckCircle />, text: "purple cover = a struck frequency" },
  { glyph: <TintSwatch />, text: "cauldron tint = the blend of the brew's fundamentals" },
];

function LegendStrip() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-3">
      {LEGEND.map((e, i) => (
        <span key={i} className="flex items-center gap-2">
          <span className="grid h-12 w-12 shrink-0 place-items-center">{e.glyph}</span>
          <span className="text-[11px] leading-snug text-text-muted">{e.text}</span>
        </span>
      ))}
    </div>
  );
}

// ── first-brew walkthrough (layer b) ──────────────────────────────────────────
// Ten cards, copy verbatim from DESIGN.md §6. Each illustration is composed from
// the real stage components above — no bespoke drawings.

const WALKTHROUGH: { title: string; doText: string; see: string; illo: React.ReactNode }[] = [
  {
    title: "Join the party",
    doText:
      'Sign in to tom.quest, open /perfume, and click "join the party" under the gear.',
    see: "you appear in the top bar with your own color and an empty inventory.",
    illo: <MemberDot />,
  },
  {
    title: "Record your ingredients",
    doText:
      'Ingredients come from the game: Joe hands them to your character; this page only keeps score. Open your inventory tab, choose Import, and paste what you own ("Noble Roses x3") or search the catalog and click items in.',
    see: "a preview confirms each line; Add fills your inventory with tan squares.",
    illo: <MiniItem real />,
  },
  {
    title: "Open a brew",
    doText: "Click + for a private brew, or click the party brew everyone shares.",
    see: "the stage shows an empty cauldron waiting at the bottom.",
    illo: <TintSwatch />,
  },
  {
    title: "Add an ingredient",
    doText:
      "Click one in your inventory (you are now carrying one; click again to carry more), then click over the stage to drop. Right-click puts one back.",
    see: "it docks above the cauldron and its frequencies rise as colored circles.",
    illo: (
      <span className="flex items-center gap-1">
        <MiniItem real />
        <FreqCircle size={22} />
      </span>
    ),
  },
  {
    title: "Watch frequencies combine",
    doText:
      "Add more ingredients; when the circles matching a named frequency's parts are all present, they fuse into one heavier circle on their own.",
    see: "the tally in the header updates with every change.",
    illo: (
      <span className="flex items-center gap-0.5">
        <FreqCircle id="Ev" size={20} />
        <FreqCircle id="C" size={20} />
        <Arrow />
        <FreqCircle id="Ignetium" size={26} />
      </span>
    ),
  },
  {
    title: "Pick a target",
    doText: "Open the perfume panel, find a perfume, and pin it.",
    see:
      "ghost circles appear on the stage — the closest path between your brew and that perfume, showing exactly what to add.",
    illo: (
      <span className="flex items-center gap-1">
        <GhostCircle size={26} />
        <GhostCircle id="A" size={26} />
      </span>
    ),
  },
  {
    title: "Plan the gap",
    doText:
      "Drag ingredients from the Ingredients tab to try ideas; they arrive on grey (hypothetical) and cost nothing.",
    see: "grey items count toward the tally, but the Brew button names them as blockers.",
    illo: <MiniItem real={false} />,
  },
  {
    title: "Make it real",
    doText:
      "Click Fill from inventory to turn your grey items tan using your stock, or swap them by hand.",
    see:
      "everything tan and no ghosts left, so the Brew button lights amber and names your perfume.",
    illo: (
      <span className="flex items-center gap-1">
        <MiniItem real={false} />
        <Arrow />
        <MiniItem real />
      </span>
    ),
  },
  {
    title: "Brew",
    doText: "Click it.",
    see:
      "the ceremony plays and the perfume settles on the cauldron, tinted by your blend; your consumed ingredients are spent for good and the graph keeps the recipe as a grey plan you can refill and brew again.",
    illo: <PerfumeSwatch />,
  },
  {
    title: "Take it, or gift it",
    doText:
      "Drag the perfume off the cauldron into your inventory. Drag any item onto a member's tab to gift it instantly.",
    see:
      "hovering a perfume shows its effect (if known), who brewed it, and who witnessed the ceremony.",
    illo: (
      <span className="flex items-center gap-1 text-accent/70">
        <PerfumeSwatch size={28} />
        <SendGlyph size={16} />
      </span>
    ),
  },
];

function WalkthroughCards() {
  return (
    <ol className="space-y-2">
      {WALKTHROUGH.map((c, i) => (
        <li
          key={i}
          className="flex gap-3 rounded-lg border border-border bg-surface-alt/40 p-2.5"
        >
          {/* the real-component illustration */}
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-md bg-bg/40">
            {c.illo}
          </span>
          <div className="min-w-0">
            <p className="font-mono text-xs font-semibold uppercase tracking-wider text-text">
              <span className="mr-1.5 text-text-faint">{i + 1}.</span>
              {c.title}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{c.doText}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-text-faint">
              <span className="font-semibold uppercase tracking-wide text-accent/80">
                You see:
              </span>{" "}
              {c.see}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ── rules (layer c) ───────────────────────────────────────────────────────────
// Verbatim from DESIGN.md §6. The lead phrase (up to the first colon) is bolded
// for scannability; the rendered text is the exact source string unchanged.

const RULES: string[] = [
  "Brewing consumes: real ingredients are spent forever; the graph does not collapse — each spent item turns grey (a plan) in place.",
  "No hypotheticals at completion: one grey item anywhere blocks brewing, and the Brew button says which.",
  "Multiples: if the tally is exactly k times a recipe, brewing yields k perfumes stacked on the cauldron.",
  "Brews persist: a brew survives brewing, survives everyone leaving, and lives at its own link until its owner (or Tom) deletes it.",
  "Ownership travels by handoff: opening someone's brew is not taking it. Copy any brew to get your own grey version.",
  "Where, not what: on someone else's brew you may rearrange where their items sit and add grey ideas — never add or remove what they own, brew it, or take from its cauldron.",
  "The party brew belongs to everyone: any member may add their own real ingredients, brew, and take; each spends only their own stock.",
  "Undo is yours alone: it rewinds only your own moves, strikes, wilds, and pins. Brewing, taking, and gifting are permanent.",
  "One pin per brew: a target perfume pinned by an owner (or anyone on the party brew), seen by everyone, replaced by the next pin. Ghosts show the closest path — additions first, strikes only when adding cannot get there.",
  "Gifts are instant: drop on a member's tab and it is theirs — no acceptance, no take-backs.",
  "Provenance is a birthmark: a perfume permanently records its effect (once known), who brewed it, and who witnessed the ceremony — nothing else.",
];

function RuleItem({ text }: { text: string }) {
  const i = text.indexOf(": ");
  const lead = i > 0 ? text.slice(0, i + 1) : null;
  const rest = i > 0 ? text.slice(i + 1) : text;
  return (
    <li className="flex gap-2 text-[11px] leading-relaxed text-text-muted">
      <span aria-hidden="true" className="mt-1 text-accent/60">
        •
      </span>
      <span>
        {lead && <strong className="text-text">{lead}</strong>}
        {rest}
      </span>
    </li>
  );
}

// ── section heading ───────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">
      {children}
    </h3>
  );
}

// ── the shared body (identical in the wide popover and the narrow sheet) ───────

function HelpBody({ onClose, headingId }: { onClose: () => void; headingId: string }) {
  return (
    <div className="flex max-h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 id={headingId} className="font-display text-sm uppercase tracking-[0.15em] text-text">
          How the Perfumer works
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close help"
          title="Close"
          className={cn(btn.ghost, "h-7 w-7 p-0 text-base")}
        >
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {/* (a) legend */}
        <section className="space-y-2.5">
          <SectionTitle>Legend</SectionTitle>
          <LegendStrip />
        </section>

        {/* (b) walkthrough */}
        <section className="space-y-2.5">
          <SectionTitle>Your first brew</SectionTitle>
          <WalkthroughCards />
        </section>

        {/* (c) rules */}
        <section className="space-y-2.5">
          <SectionTitle>Rules</SectionTitle>
          <ul className="space-y-1.5">
            {RULES.map((r, i) => (
              <RuleItem key={i} text={r} />
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

// ── the full-screen sheet (narrow viewport) ───────────────────────────────────

function HelpSheet({ onClose, headingId }: { onClose: () => void; headingId: string }) {
  const ref = useDismissable<HTMLDivElement>(onClose);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex flex-col bg-black/60 motion-safe:transition-opacity">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="mt-auto flex max-h-[92vh] min-h-0 flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface shadow-2xl"
      >
        <HelpBody onClose={onClose} headingId={headingId} />
      </div>
    </div>,
    document.body,
  );
}

// ── narrow-viewport hook ──────────────────────────────────────────────────────

function useNarrow(query = "(max-width: 640px)"): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const sync = () => setNarrow(m.matches);
    sync();
    m.addEventListener("change", sync);
    return () => m.removeEventListener("change", sync);
  }, [query]);
  return narrow;
}

// ── the "?" trigger + popup ────────────────────────────────────────────────────

export default function HelpPopup({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<PopoverAnchor | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const narrow = useNarrow();
  const headingId = "perfume-help-title";

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAt({ x: r.right, y: r.top });
    setOpen(true);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-label="How the Perfumer works"
        aria-expanded={open}
        aria-pressed={open}
        title="How it works"
        className={cn(btn.icon, "h-8 w-8 bg-surface/85 p-0 text-sm font-semibold backdrop-blur", className)}
      >
        ?
      </button>

      {open && narrow && <HelpSheet onClose={() => setOpen(false)} headingId={headingId} />}

      {open && !narrow && at && (
        <Popover
          anchor={at}
          align="right"
          width={420}
          role="dialog"
          label="How the Perfumer works"
          onClose={() => setOpen(false)}
          className="flex max-h-[80vh] flex-col overflow-hidden p-0"
        >
          <HelpBody onClose={() => setOpen(false)} headingId={headingId} />
        </Popover>
      )}
    </>
  );
}
