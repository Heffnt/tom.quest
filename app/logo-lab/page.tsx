import type { ReactNode, CSSProperties } from "react";
import {
  IBM_Plex_Mono,
  JetBrains_Mono,
  Space_Mono,
  Fira_Code,
  Roboto_Mono,
  DM_Mono,
  Source_Code_Pro,
} from "next/font/google";

/* ─────────────────────────────────────────────────────────────
   Monospace font candidates.
   Each family is loaded statically by next/font at build time
   and exposes a `.style.fontFamily` string we can pipe into
   SVG <text fontFamily={...}>.
   ───────────────────────────────────────────────────────────── */

const plexMono    = IBM_Plex_Mono  ({ subsets: ["latin"], weight: ["500", "600"] });
const jbMono      = JetBrains_Mono ({ subsets: ["latin"], weight: ["500", "700"] });
const spaceMono   = Space_Mono     ({ subsets: ["latin"], weight: ["400", "700"] });
const firaCode    = Fira_Code      ({ subsets: ["latin"], weight: ["500", "600"] });
const robotoMono  = Roboto_Mono    ({ subsets: ["latin"], weight: ["500", "700"] });
const dmMono      = DM_Mono        ({ subsets: ["latin"], weight: ["500"] });
const sourceCode  = Source_Code_Pro({ subsets: ["latin"], weight: ["500", "600"] });

type FontOption = {
  id: string;
  label: string;
  family: string;
  weight: number;
  note: string;
};

const FONTS: FontOption[] = [
  { id: "plex",    label: "IBM Plex Mono",    family: plexMono.style.fontFamily,   weight: 500, note: "Already on the site. Humanist, slightly warm. Narrow-oval Q." },
  { id: "jb",      label: "JetBrains Mono",   family: jbMono.style.fontFamily,     weight: 500, note: "Geometric, very even colour. Round Q. Strong dev-tool association." },
  { id: "space",   label: "Space Mono",       family: spaceMono.style.fontFamily,  weight: 400, note: "Retro-futurist. Square-ish rounded Q. Most 'characterful' — loudest option." },
  { id: "fira",    label: "Fira Code",        family: firaCode.style.fontFamily,   weight: 500, note: "Open apertures, slightly humanist. Oval Q." },
  { id: "roboto",  label: "Roboto Mono",      family: robotoMono.style.fontFamily, weight: 500, note: "Neutral, corporate-tech. Round but thin Q." },
  { id: "dm",      label: "DM Mono",          family: dmMono.style.fontFamily,     weight: 500, note: "Soft geometric. Near-circular Q. Quietly distinctive." },
  { id: "source",  label: "Source Code Pro",  family: sourceCode.style.fontFamily, weight: 500, note: "Adobe's coder mono. Razor-clean, geometric. Near-circular Q." },
];

/* ─────────────────────────────────────────────────────────────
   Logo geometry
   ─────────────────────────────────────────────────────────────
   Layout is 9 monospace cells wide: t o m . Q u e s t
   Each cell has width W = fontSize * 0.6 (the standard mono
   advance ratio). `textLength` + `lengthAdjust="spacing"` force
   actual rendered width to exactly 4W per side regardless of the
   font's real metrics — so the left 't' and right 't' are
   provably equidistant from the Q at cell 5.
   ───────────────────────────────────────────────────────────── */

const FONT_SIZE   = 140;
const W           = FONT_SIZE * 0.6;          // 84 — mono advance cell
const MARGIN      = 24;
const TOTAL_W     = MARGIN * 2 + 9 * W;       // 804
const BASELINE    = 140;
const CAP_TOP     = 42;                       // ≈ baseline - 0.7·fontSize
const X_HEIGHT_TOP = 70;                      // ≈ baseline - 0.5·fontSize
const HEIGHT      = 182;
const BAR_Y       = X_HEIGHT_TOP;             // bar centreline
const BAR_H       = 10;
const UNDERLINE_Y = BASELINE + 14;

const Q_CX        = MARGIN + 4.5 * W;          // centre of cell 5
const Q_CY        = (CAP_TOP + BASELINE) / 2;  // vertically centred in cap-height
const Q_R         = (BASELINE - CAP_TOP) / 2;  // 49

const STROKE      = 12;

/* Custom period dot — takes the place of cell 4 ('.').
   Sized to carry the visual weight of a letter, so the
   left of the Q reads as 3 glyphs + dot (4 masses) to match
   'uest' on the right (also 4 masses). This is what makes the
   two t's visually equidistant from the Q, not just cell-wise.   */
const DOT_CX      = MARGIN + 3.5 * W;
const DOT_SIZE    = 26;                      // substantial, not font-dust
const DOT_Y       = BASELINE - DOT_SIZE;

/* Three lines descend from the midpoint of the bar at (Q_CX, BAR_Y).
   Left points at the dot, stops at the Q's circle edge.
   Right mirrors that angle and extends past the Q as the tail.    */
const DIAG_DX     = DOT_CX - Q_CX;           // negative: -84  → slope targets the dot
const DIAG_DY     = (BASELINE - DOT_SIZE / 2) - BAR_Y; // 57
const LEFT_CUT    = 0.60;                    // stop at 60% of the reach (on the Q circle)
const LEFT_END_X  = Q_CX + DIAG_DX * LEFT_CUT;
const LEFT_END_Y  = BAR_Y + DIAG_DY * LEFT_CUT;
const RIGHT_END_X = Q_CX - DIAG_DX * 0.85;   // mirror, extends past the Q
const RIGHT_END_Y = BAR_Y + DIAG_DY * 0.85;

/* ─────────────────────────────────────────────────────────────
   <Logo /> — parameterised by font family
   ───────────────────────────────────────────────────────────── */

function Logo({
  family,
  weight = 500,
  showRails = true,
  className,
  style,
}: {
  family: string;
  weight?: number;
  showRails?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox={`0 0 ${TOTAL_W} ${HEIGHT}`}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      {/* Structural top rail — doubles as the t-crossbars and the
          horizontal of the tom-symbol. Hidden when showRails=false. */}
      {showRails && (
        <>
          <rect x="0" y={BAR_Y - BAR_H / 2} width={TOTAL_W} height={BAR_H} />
          <rect x="0" y={UNDERLINE_Y - BAR_H / 2} width={TOTAL_W} height={BAR_H} />
        </>
      )}

      {/* "tom" — 3 cells. Period is not a text char; it's drawn below. */}
      <text
        x={MARGIN}
        y={BASELINE}
        fontFamily={family}
        fontWeight={weight}
        fontSize={FONT_SIZE}
        textLength={3 * W}
        lengthAdjust="spacing"
        style={{ fontVariantLigatures: "none" }}
      >
        tom
      </text>

      {/* Custom period dot — cell 4, baseline-aligned.
          Square so it mirrors the Q-tail terminus visually. */}
      <rect
        x={DOT_CX - DOT_SIZE / 2}
        y={DOT_Y}
        width={DOT_SIZE}
        height={DOT_SIZE}
      />

      {/* "uest" — left-edge starts exactly at Q's right cell (cell 6) */}
      <text
        x={MARGIN + 5 * W}
        y={BASELINE}
        fontFamily={family}
        fontWeight={weight}
        fontSize={FONT_SIZE}
        textLength={4 * W}
        lengthAdjust="spacing"
        style={{ fontVariantLigatures: "none" }}
      >
        uest
      </text>

      {/* ── Q mark ─────────────────────────────────────────── */}
      {/* Circle (the 'O' of tom) */}
      <circle
        cx={Q_CX}
        cy={Q_CY}
        r={Q_R}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
      />

      {/* Vertical: meets horizontal bar to form the 'T' of tom.
          Starts just under the bar, descends through the Q. */}
      <line
        x1={Q_CX}
        y1={BAR_Y}
        x2={Q_CX}
        y2={BASELINE}
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="butt"
      />

      {/* Right diagonal — mirrors the left's angle, extends past the Q. */}
      <line
        x1={Q_CX}
        y1={BAR_Y}
        x2={RIGHT_END_X}
        y2={RIGHT_END_Y}
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="butt"
      />

      {/* Left diagonal — stops inside / at the Q circle.
          The period in 'tom.' sits at the continuation of its
          trajectory, serving as the 'dot' terminus. */}
      <line
        x1={Q_CX}
        y1={BAR_Y}
        x2={LEFT_END_X}
        y2={LEFT_END_Y}
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="butt"
      />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────
   Page
   ───────────────────────────────────────────────────────────── */

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
        className={`flex items-center justify-center rounded-md p-6 ${border ?? ""}`}
        style={{ background: bg, color: fg }}
      >
        {children}
      </div>
      <div className="text-[11px] text-text-muted font-mono uppercase tracking-wider">
        {label}
      </div>
    </div>
  );
}

export default function LogoLab() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      <header className="animate-settle">
        <div className="text-xs font-mono uppercase tracking-[0.2em] text-accent">
          Logo Lab · v2
        </div>
        <h1 className="mt-2 text-4xl font-bold tracking-tight">
          tom.Quest · font candidates
        </h1>
        <p className="mt-4 text-text-muted max-w-3xl leading-relaxed">
          The Q-mark is a single custom SVG — a perfect circle (the <em>o</em>)
          with a horizontal bar inside, three lines descending from its
          midpoint (the stylised <em>m</em>), the vertical forming a <em>T</em>{" "}
          with the bar, the right line extending out as the Q&apos;s tail, and
          the left line stopping where the period of <code className="font-mono text-text">tom.</code>{" "}
          takes over. No cap on top.
        </p>
        <p className="mt-3 text-text-muted max-w-3xl leading-relaxed">
          All candidates below are <strong>monospace</strong> — so each cell is
          equal width. To make the two <code className="font-mono text-text">t</code>
          s <em>visually</em> equidistant (not just cell-wise), the period is
          drawn as a substantial custom square rather than the font&apos;s tiny
          dot. Left reads as 4 masses (<code className="font-mono text-text">t&nbsp;o&nbsp;m&nbsp;●</code>)
          and right as 4 masses (<code className="font-mono text-text">u&nbsp;e&nbsp;s&nbsp;t</code>)
          — balanced around a custom circular Q.
        </p>
      </header>

      {/* ── The shortlist ───────────────────────────────────── */}
      <section className="mt-16 flex flex-col gap-16">
        {FONTS.map(({ id, label, family, weight, note }, i) => (
          <article
            key={id}
            className={`animate-settle-delay-${Math.min(i + 1, 3)}`}
          >
            <div className="flex items-baseline justify-between border-b border-border pb-3 mb-6">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">
                  {label}
                </h2>
                <div className="text-sm text-text-muted mt-1">{note}</div>
              </div>
              <div className="text-xs text-text-faint font-mono">#{id}</div>
            </div>

            {/* Hero */}
            <Swatch
              label="white on ink · rails on"
              bg="var(--color-bg)"
              fg="var(--color-text)"
              border="border border-border"
            >
              <Logo
                family={family}
                weight={weight}
                className="w-full max-w-3xl h-auto"
              />
            </Swatch>

            {/* Colour + rails-off grid */}
            <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-6">
              <Swatch
                label="amber on dark · rails on"
                bg="var(--color-surface)"
                fg="var(--color-accent)"
                border="border border-border"
              >
                <Logo family={family} weight={weight} className="w-full h-auto" />
              </Swatch>
              <Swatch label="rails off · ink on paper" bg="#f5f1e8" fg="#0a0e17">
                <Logo
                  family={family}
                  weight={weight}
                  showRails={false}
                  className="w-full h-auto"
                />
              </Swatch>
              <Swatch label="knockout" bg="#e8a040" fg="#0a0e17">
                <Logo family={family} weight={weight} className="w-full h-auto" />
              </Swatch>
            </div>

            {/* Scale test */}
            <div className="mt-4 flex flex-wrap items-center gap-8 p-5 rounded-md border border-border bg-surface">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-text-muted w-14">
                  nav 30
                </span>
                <Logo family={family} weight={weight} style={{ height: 30, width: "auto" }} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-text-muted w-14">
                  tiny 20
                </span>
                <Logo family={family} weight={weight} style={{ height: 20, width: "auto" }} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-text-muted w-14">
                  no rails
                </span>
                <Logo
                  family={family}
                  weight={weight}
                  showRails={false}
                  style={{ height: 30, width: "auto" }}
                />
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* ── Reference: the font's OWN Q rendering ───────────── */}
      <section className="mt-24">
        <div className="border-b border-border pb-3 mb-6">
          <h2 className="text-xl font-semibold tracking-tight">
            Reference · each font&apos;s native Q
          </h2>
          <p className="text-sm text-text-muted mt-1">
            For comparison only — straight <code className="font-mono text-text">tom.Quest</code>{" "}
            in the font with no overlay. Lets you judge which fonts have a Q
            shape that already reads as circular.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {FONTS.map(({ id, label, family, weight }) => (
            <div
              key={id}
              className="flex items-center justify-between gap-6 p-6 rounded-md border border-border bg-surface"
            >
              <span
                style={{
                  fontFamily: family,
                  fontWeight: weight,
                  fontSize: 56,
                  letterSpacing: "-0.02em",
                }}
              >
                tom.Quest
              </span>
              <span className="text-xs font-mono text-text-muted">{label}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="mt-20 pt-8 border-t border-border text-sm text-text-muted leading-relaxed">
        Tell me which font (<code className="font-mono text-text">#plex</code>,{" "}
        <code className="font-mono text-text">#dm</code>,{" "}
        <code className="font-mono text-text">#geist</code>, etc.) and whether
        you want rails on or off, and I&apos;ll export a single{" "}
        <code className="font-mono text-text">logo.svg</code>, swap it into{" "}
        <code className="font-mono text-text">navigation.tsx</code>, and delete
        the four old colour-variant files.
      </footer>
    </div>
  );
}
