import type { ReactNode, SVGProps } from "react";

/* ============================================================
   LOGO MARK A — "Editorial"
   Syne display font + custom circular Q with internal tom-symbol.
   No stencil bars — lets the type breathe. Most refined.
   ============================================================ */
function LogoEditorial(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 840 170"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* "tom" — Syne bold, right-aligned against the Q */}
      <text
        x="338"
        y="134"
        textAnchor="end"
        fontFamily="var(--font-syne), Syne, 'Syne Variable', sans-serif"
        fontWeight={700}
        fontSize={148}
        letterSpacing="-0.03em"
      >
        tom
      </text>

      {/* Period dot — drawn as a true square to mirror the Q-tail square */}
      <rect x="349" y="118" width="18" height="18" />

      {/* Q — perfect circle, centered */}
      <circle
        cx="420"
        cy="82"
        r="58"
        fill="none"
        stroke="currentColor"
        strokeWidth="13"
      />

      {/* tom-symbol inside Q: central vertical stroke */}
      <rect x="413" y="28" width="14" height="108" />

      {/* tom-symbol: top cap (mirrors the caps on lowercase t stems) */}
      <rect x="402" y="8" width="36" height="20" />

      {/* Q tail — diagonal from Q centre extending past lower-right edge */}
      <rect
        x="413"
        y="82"
        width="14"
        height="80"
        transform="rotate(-45 420 82)"
      />

      {/* "uest" — Syne bold, left-aligned off the Q */}
      <text
        x="490"
        y="134"
        fontFamily="var(--font-syne), Syne, 'Syne Variable', sans-serif"
        fontWeight={700}
        fontSize={148}
        letterSpacing="-0.03em"
      >
        uest
      </text>
    </svg>
  );
}

/* ============================================================
   LOGO MARK B — "Stencil / Research"
   IBM Plex Mono + horizontal connector + underline running the
   full width. Technical / research-journal energy.
   ============================================================ */
function LogoStencil(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 860 170"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Top connector bar */}
      <rect x="0" y="30" width="860" height="10" />

      {/* Bottom underline */}
      <rect x="0" y="132" width="860" height="10" />

      {/* "tom" in Plex Mono */}
      <text
        x="16"
        y="128"
        fontFamily="var(--font-ibm-plex-mono), 'IBM Plex Mono', monospace"
        fontWeight={500}
        fontSize={128}
        letterSpacing="-0.01em"
      >
        tom
      </text>

      {/* Square period, baseline-aligned, mirror of Q-tail */}
      <rect x="338" y="116" width="16" height="16" />

      {/* Q — perfect circle, slightly larger than x-height */}
      <circle
        cx="430"
        cy="86"
        r="54"
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
      />

      {/* tom-symbol inside Q */}
      <rect x="424" y="32" width="12" height="108" />
      {/* top cap — pokes above the connector bar, same height as the t-stem caps */}
      <rect x="414" y="10" width="32" height="20" />

      {/* Q tail diagonal */}
      <rect
        x="424"
        y="86"
        width="12"
        height="78"
        transform="rotate(-45 430 86)"
      />

      {/* "uest" in Plex Mono */}
      <text
        x="498"
        y="128"
        fontFamily="var(--font-ibm-plex-mono), 'IBM Plex Mono', monospace"
        fontWeight={500}
        fontSize={128}
        letterSpacing="-0.01em"
      >
        uest
      </text>

      {/* Tiny accent squares sitting above the connector bar on each t-stem
          — preserves the original's "caps poking above the top line" detail. */}
      <rect x="18" y="10" width="14" height="20" />
      <rect x="828" y="10" width="14" height="20" />
    </svg>
  );
}

/* ============================================================
   LOGO MARK C — "Geometric / No-font"
   Fully path-based. Portable anywhere, any color, no font files.
   Monoline 12-unit strokes throughout.
   ============================================================ */
function LogoGeometric(props: SVGProps<SVGSVGElement>) {
  // Every shape uses stroke=12 or rect-width=12 for visual consistency.
  return (
    <svg
      viewBox="0 0 820 160"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Top structural line + bottom underline */}
      <rect x="0" y="30" width="820" height="10" />
      <rect x="0" y="130" width="820" height="10" />

      {/* ── lowercase t (tom) ── stem centre x=28 */}
      <rect x="22" y="6" width="12" height="136" />
      <rect x="10" y="6" width="36" height="18" />

      {/* ── lowercase o ── centre x=98 */}
      <ellipse
        cx="98"
        cy="96"
        rx="36"
        ry="40"
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
      />

      {/* ── lowercase m ── three stems + two hump arcs, centre x=220 */}
      <rect x="166" y="60" width="12" height="82" />
      <rect x="214" y="60" width="12" height="82" />
      <rect x="262" y="60" width="12" height="82" />
      <path
        d="M 172 60 Q 172 56 178 56 L 214 56 Q 220 56 220 62"
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
      />
      <path
        d="M 220 60 Q 220 56 226 56 L 262 56 Q 268 56 268 62"
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
      />

      {/* ── period dot (square, mirrors Q-tail) ── */}
      <rect x="292" y="124" width="18" height="18" />

      {/* ── capital Q ── centre (410, 80), perfect circle */}
      <circle
        cx="410"
        cy="80"
        r="56"
        fill="none"
        stroke="currentColor"
        strokeWidth="13"
      />
      {/* Inner tom-symbol: vertical */}
      <rect x="403" y="26" width="14" height="108" />
      {/* Top cap */}
      <rect x="392" y="6" width="36" height="20" />
      {/* Q tail */}
      <rect
        x="403"
        y="80"
        width="14"
        height="78"
        transform="rotate(-45 410 80)"
      />

      {/* ── lowercase u ── centre x=536 */}
      <rect x="504" y="60" width="12" height="60" />
      <rect x="556" y="60" width="12" height="82" />
      <path
        d="M 504 120 Q 504 142 526 142 L 546 142 Q 568 142 568 120"
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
      />

      {/* ── lowercase e ── centre x=622 */}
      <ellipse
        cx="622"
        cy="96"
        rx="34"
        ry="40"
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
      />
      <rect x="588" y="92" width="68" height="12" />

      {/* ── lowercase s ── centre x=700 — two stacked arcs */}
      <path
        d="M 728 66 Q 718 56 704 56 Q 680 56 680 74 Q 680 90 704 94 L 720 98 Q 740 102 740 120 Q 740 140 716 140 Q 698 140 686 128"
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="square"
      />

      {/* ── lowercase t (quest) ── stem centre x=788 */}
      <rect x="782" y="6" width="12" height="136" />
      <rect x="770" y="6" width="36" height="18" />
    </svg>
  );
}

/* ============================================================
   SYMBOL MARK — the Q-mark only.
   For favicons, avatars, tight spaces, button adornments.
   ============================================================ */
function SymbolMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 160 160"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle
        cx="80"
        cy="86"
        r="56"
        fill="none"
        stroke="currentColor"
        strokeWidth="13"
      />
      <rect x="73" y="30" width="14" height="112" />
      <rect x="62" y="10" width="36" height="20" />
      <rect
        x="73"
        y="86"
        width="14"
        height="78"
        transform="rotate(-45 80 86)"
      />
    </svg>
  );
}

/* ============================================================
   PAGE
   ============================================================ */

type Mockup = {
  id: string;
  name: string;
  tagline: string;
  notes: string[];
  Component: (props: SVGProps<SVGSVGElement>) => ReactNode;
};

const MOCKUPS: Mockup[] = [
  {
    id: "editorial",
    name: "Editorial",
    tagline: "Syne display · no stencil bars",
    notes: [
      "Uses the site's existing display font (Syne, 700).",
      "Perfect-circle Q with centred tom-symbol + mirrored square dot / tail.",
      "Most refined; best when the logo has space around it.",
    ],
    Component: LogoEditorial,
  },
  {
    id: "stencil",
    name: "Stencil / Research",
    tagline: "IBM Plex Mono · top & bottom rails",
    notes: [
      "Uses the site's monospace face — reinforces the research identity.",
      "Top connector + underline run the full width, echoing the original's structural lines.",
      "Small caps above the connector preserve the 'poking-up t-tops' detail.",
    ],
    Component: LogoStencil,
  },
  {
    id: "geometric",
    name: "Geometric (no-font)",
    tagline: "Pure paths · portable anywhere",
    notes: [
      "Every letter drawn from rects + arcs — no font file required.",
      "Safe to export as a standalone asset (PDF, print, external sites).",
      "Honours the original concept most literally: structural line doubles as t-crossbar.",
    ],
    Component: LogoGeometric,
  },
];

function Swatch({
  label,
  bg,
  fg,
  border,
  children,
}: {
  label: string;
  bg: string;
  fg: string;
  border?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className={`flex items-center justify-center rounded-md p-8 ${border ?? ""}`}
        style={{ background: bg, color: fg }}
      >
        {children}
      </div>
      <div className="text-xs text-text-muted font-mono uppercase tracking-wider">
        {label}
      </div>
    </div>
  );
}

export default function LogoLab() {
  return (
    <div className="max-w-5xl mx-auto px-6 py-16">
      <header className="animate-settle">
        <div className="text-xs font-mono uppercase tracking-[0.2em] text-accent">
          Logo Lab
        </div>
        <h1 className="mt-2 text-4xl font-bold tracking-tight">
          tom.Quest · identity mockups
        </h1>
        <p className="mt-3 text-text-muted max-w-2xl leading-relaxed">
          Three directions for a clean, reusable SVG logo. All marks use{" "}
          <code className="font-mono text-text">currentColor</code>, so one file
          works in any colour at any size. Decide which direction — then that
          SVG replaces the hand-traced one in{" "}
          <code className="font-mono text-text">/public/images/</code>.
        </p>
      </header>

      <section className="mt-16 flex flex-col gap-20">
        {MOCKUPS.map(({ id, name, tagline, notes, Component }, i) => (
          <article
            key={id}
            className={`animate-settle-delay-${Math.min(i + 1, 3)}`}
          >
            <div className="flex items-baseline justify-between border-b border-border pb-3 mb-8">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">
                  {i + 1}. {name}
                </h2>
                <div className="text-sm text-text-muted font-mono mt-1">
                  {tagline}
                </div>
              </div>
              <div className="text-xs text-text-faint font-mono">#{id}</div>
            </div>

            {/* Large hero swatch */}
            <Swatch
              label="hero · white on ink"
              bg="var(--color-bg)"
              fg="var(--color-text)"
              border="border border-border"
            >
              <Component className="w-full max-w-2xl h-auto" />
            </Swatch>

            {/* Colour / scale grid */}
            <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
              <Swatch
                label="amber accent · dark"
                bg="var(--color-surface)"
                fg="var(--color-accent)"
                border="border border-border"
              >
                <Component className="w-full h-auto" />
              </Swatch>
              <Swatch label="ink on paper" bg="#f5f1e8" fg="#0a0e17">
                <Component className="w-full h-auto" />
              </Swatch>
              <Swatch label="white knockout" bg="#e8a040" fg="#0a0e17">
                <Component className="w-full h-auto" />
              </Swatch>
            </div>

            {/* Scale test — nav-size and tiny */}
            <div className="mt-6 flex items-center gap-8 p-6 rounded-md border border-border bg-surface">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-text-muted w-16">
                  nav (30px)
                </span>
                <Component style={{ height: 30, width: "auto" }} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-text-muted w-16">
                  tiny (18px)
                </span>
                <Component style={{ height: 18, width: "auto" }} />
              </div>
            </div>

            {/* Notes */}
            <ul className="mt-6 space-y-1.5 text-sm text-text/80 leading-relaxed list-disc list-inside">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </article>
        ))}

        {/* Symbol mark */}
        <article>
          <div className="flex items-baseline justify-between border-b border-border pb-3 mb-8">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">
                ⊕ Symbol mark
              </h2>
              <div className="text-sm text-text-muted font-mono mt-1">
                Q-only · favicon, avatar, tab icon
              </div>
            </div>
            <div className="text-xs text-text-faint font-mono">#symbol</div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <Swatch
              label="dark"
              bg="var(--color-bg)"
              fg="var(--color-text)"
              border="border border-border"
            >
              <SymbolMark className="w-24 h-24" />
            </Swatch>
            <Swatch
              label="accent"
              bg="var(--color-surface)"
              fg="var(--color-accent)"
              border="border border-border"
            >
              <SymbolMark className="w-24 h-24" />
            </Swatch>
            <Swatch label="paper" bg="#f5f1e8" fg="#0a0e17">
              <SymbolMark className="w-24 h-24" />
            </Swatch>
            <Swatch label="knockout" bg="#e8a040" fg="#0a0e17">
              <SymbolMark className="w-24 h-24" />
            </Swatch>
          </div>

          <div className="mt-6 flex items-center gap-8 p-6 rounded-md border border-border bg-surface">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-text-muted w-16">
                32px
              </span>
              <SymbolMark style={{ height: 32, width: 32 }} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-text-muted w-16">
                16px
              </span>
              <SymbolMark style={{ height: 16, width: 16 }} />
            </div>
          </div>
        </article>
      </section>

      <footer className="mt-20 pt-8 border-t border-border text-sm text-text-muted">
        Once you pick one, I&apos;ll export it as a static file in{" "}
        <code className="font-mono text-text">/public/images/logo.svg</code>{" "}
        and swap <code className="font-mono text-text">navigation.tsx</code> to
        render it with <code className="font-mono text-text">currentColor</code>
        . Then the four existing colour variants can be deleted.
      </footer>
    </div>
  );
}
