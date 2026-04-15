"use client";

import { useEffect, useRef, useState } from "react";
import {
  Syne,
  Unbounded,
  Archivo_Black,
  Space_Grotesk,
  Sora,
  Chakra_Petch,
  Orbitron,
  Manrope,
  Jost,
  Work_Sans,
  Poppins,
  Plus_Jakarta_Sans,
  Rubik,
  Familjen_Grotesk,
} from "next/font/google";
import TomSymbol from "../components/tom-symbol";

/* ─────────────────────────────────────────────────────────────
   Font candidates. Each is loaded at 700 where possible for the
   chunky "logotype" weight we want, with `display: swap` so the
   page renders text immediately (measured later once fonts settle).
   ───────────────────────────────────────────────────────────── */

const syne            = Syne            ({ subsets: ["latin"], weight: ["700", "800"], display: "swap" });
const unbounded       = Unbounded       ({ subsets: ["latin"], weight: ["700"],        display: "swap" });
const archivoBlack    = Archivo_Black   ({ subsets: ["latin"], weight: ["400"],        display: "swap" });
const spaceGrotesk    = Space_Grotesk   ({ subsets: ["latin"], weight: ["700"],        display: "swap" });
const sora            = Sora            ({ subsets: ["latin"], weight: ["700"],        display: "swap" });
const chakraPetch     = Chakra_Petch    ({ subsets: ["latin"], weight: ["700"],        display: "swap" });
const orbitron        = Orbitron        ({ subsets: ["latin"], weight: ["700"],        display: "swap" });
const manrope         = Manrope         ({ subsets: ["latin"], weight: ["700"],        display: "swap" });
const jost            = Jost            ({ subsets: ["latin"], weight: ["700"],        display: "swap" });
const workSans        = Work_Sans       ({ subsets: ["latin"], weight: ["700"],        display: "swap" });
const poppins         = Poppins         ({ subsets: ["latin"], weight: ["700"],        display: "swap" });
const plusJakartaSans = Plus_Jakarta_Sans({ subsets: ["latin"], weight: ["700"],       display: "swap" });
const rubik           = Rubik           ({ subsets: ["latin"], weight: ["700"],        display: "swap" });
const familjen        = Familjen_Grotesk({ subsets: ["latin"], weight: ["700"],        display: "swap" });

type FontSpec = {
  name:      string;
  className: string;
  weight:    number;
  note?:     string;
};

const FONTS: FontSpec[] = [
  { name: "Syne",              className: syne.className,            weight: 800, note: "site display font" },
  { name: "Unbounded",         className: unbounded.className,       weight: 700 },
  { name: "Archivo Black",     className: archivoBlack.className,    weight: 400 },
  { name: "Space Grotesk",     className: spaceGrotesk.className,    weight: 700 },
  { name: "Sora",              className: sora.className,            weight: 700 },
  { name: "Chakra Petch",      className: chakraPetch.className,     weight: 700 },
  { name: "Orbitron",          className: orbitron.className,        weight: 700 },
  { name: "Manrope",           className: manrope.className,         weight: 700 },
  { name: "Jost",              className: jost.className,            weight: 700 },
  { name: "Work Sans",         className: workSans.className,        weight: 700 },
  { name: "Poppins",           className: poppins.className,         weight: 700 },
  { name: "Plus Jakarta Sans", className: plusJakartaSans.className, weight: 700 },
  { name: "Rubik",             className: rubik.className,           weight: 700 },
  { name: "Familjen Grotesk",  className: familjen.className,        weight: 700 },
];

/* The default tom-symbol (stroke=43) fills x∈[103,552], y∈[78.5,461.5].
   This cropped viewBox pads horizontally and pins the baseline to the
   SVG bottom edge so `vertical-align: baseline` Just Works.              */
const SYMBOL_VB    = "70 78.5 500 383";
const SYMBOL_AR    = 500 / 383;   // width / height — display width = height × AR

export default function FontLab() {
  const [fontSize,   setFontSize]   = useState(96);
  const [symbolHeightEm, setSymbolHeightEm] = useState(0.72); // ~cap height
  const [letterSpacing, setLetterSpacing] = useState(0);
  const [accent, setAccent] = useState(false);

  const omRefs  = useRef<Record<string, HTMLSpanElement | null>>({});
  const uesRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const [widths, setWidths] = useState<Record<string, { om: number; ues: number }>>({});

  useEffect(() => {
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const next: Record<string, { om: number; ues: number }> = {};
      for (const f of FONTS) {
        const o = omRefs.current[f.name];
        const u = uesRefs.current[f.name];
        if (o && u) {
          next[f.name] = {
            om:  o.getBoundingClientRect().width,
            ues: u.getBoundingClientRect().width,
          };
        }
      }
      setWidths(next);
    };
    document.fonts.ready.then(() => requestAnimationFrame(measure));
  }, [fontSize, letterSpacing]);

  const sorted = [...FONTS].sort((a, b) => {
    const wa = widths[a.name], wb = widths[b.name];
    if (!wa || !wb) return 0;
    return Math.abs(wa.om - wa.ues) - Math.abs(wb.om - wb.ues);
  });

  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      <header className="animate-settle">
        <div className="text-xs font-mono uppercase tracking-[0.2em] text-accent">
          Font Lab · tom.Quest logotype
        </div>
        <h1 className="mt-2 text-4xl font-bold tracking-tight">
          Pick a typeface
        </h1>
        <p className="mt-4 text-text-muted max-w-3xl leading-relaxed">
          Each row renders <span className="font-mono text-xs">t&nbsp;om&nbsp;</span>
          &lt;symbol&gt;<span className="font-mono text-xs">&nbsp;ues&nbsp;t</span>.
          We want <span className="font-mono text-xs">om</span> width ≈{" "}
          <span className="font-mono text-xs">ues</span> width so the Q sits
          optically centered between the two <span className="font-mono text-xs">t</span>s.
          Rows are sorted by |Δ| ascending once fonts load.
        </p>
      </header>

      {/* Controls */}
      <div className="mt-8 rounded-md border border-border bg-surface p-4 grid grid-cols-1 md:grid-cols-4 gap-4">
        <ControlSlider label="fontSize"       value={fontSize}       min={48}  max={200} step={1}    onChange={setFontSize}       suffix="px" />
        <ControlSlider label="symbol height"  value={symbolHeightEm} min={0.4} max={1.2} step={0.01} onChange={setSymbolHeightEm} suffix="em" />
        <ControlSlider label="letterSpacing"  value={letterSpacing}  min={-0.05} max={0.15} step={0.005} onChange={setLetterSpacing} suffix="em" />
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => setAccent(v => !v)}
            className={`text-xs font-mono px-3 py-1.5 rounded border transition-colors ${
              accent ? "bg-accent text-bg border-accent" : "border-border text-text-muted hover:text-text"
            }`}
          >
            accent color
          </button>
        </div>
      </div>

      {/* Font rows */}
      <div className="mt-8 flex flex-col gap-4">
        {sorted.map((f) => {
          const w = widths[f.name];
          const delta = w ? w.om - w.ues : null;
          return (
            <div
              key={f.name}
              className="rounded-md border border-border bg-surface px-6 py-5"
            >
              <div className="flex items-baseline justify-between mb-3 text-xs font-mono">
                <span className="text-text uppercase tracking-wider">
                  {f.name}
                  <span className="text-text-faint ml-2 normal-case tracking-normal">
                    · weight {f.weight}
                    {f.note ? ` · ${f.note}` : ""}
                  </span>
                </span>
                <span className="text-text-muted">
                  {w
                    ? `om ${w.om.toFixed(1)} · ues ${w.ues.toFixed(1)} · Δ ${delta!.toFixed(1)}px (${
                        delta! > 0 ? "om wider" : delta! < 0 ? "ues wider" : "equal"
                      })`
                    : "measuring…"}
                </span>
              </div>

              <div
                className={f.className}
                style={{
                  fontSize,
                  fontWeight:    f.weight,
                  lineHeight:    1,
                  letterSpacing: `${letterSpacing}em`,
                  color:         accent ? "var(--color-accent)" : "var(--color-text)",
                  display:       "inline-flex",
                  alignItems:    "baseline",
                }}
              >
                <span>t</span>
                <span ref={(el) => { omRefs.current[f.name] = el; }}>om</span>
                <span
                  aria-hidden
                  style={{
                    display: "inline-block",
                    height:  `${symbolHeightEm}em`,
                    width:   `${symbolHeightEm * SYMBOL_AR}em`,
                    verticalAlign: "baseline",
                  }}
                >
                  <svg
                    viewBox={SYMBOL_VB}
                    width="100%"
                    height="100%"
                    style={{ display: "block", color: "inherit" }}
                    preserveAspectRatio="xMidYMax meet"
                  >
                    <TomSymbol />
                  </svg>
                </span>
                <span ref={(el) => { uesRefs.current[f.name] = el; }}>ues</span>
                <span>t</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ControlSlider({
  label, value, min, max, step, onChange, suffix,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; suffix?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs font-mono">
        <span className="text-text">{label}</span>
        <span className="text-text-muted">{value}{suffix ?? ""}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-[var(--color-accent)]"
      />
    </div>
  );
}
