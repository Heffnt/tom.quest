"use client";

import TomLogo from "../components/tom-logo";

const SIZES = [24, 36, 48, 72, 120];

type Swatch = {
  label: string;
  bg:    string;
  color: string;
};

const SWATCHES: Swatch[] = [
  { label: "default",  bg: "var(--color-bg)",          color: "var(--color-text)"    },
  { label: "surface",  bg: "var(--color-surface)",     color: "var(--color-text)"    },
  { label: "accent",   bg: "var(--color-bg)",          color: "var(--color-accent)"  },
  { label: "muted",    bg: "var(--color-bg)",          color: "var(--color-text-muted)" },
  { label: "inverted", bg: "var(--color-text)",        color: "var(--color-bg)"      },
  { label: "accent bg",bg: "var(--color-accent)",      color: "var(--color-bg)"      },
];

export default function LogoFinal() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      <header className="animate-settle">
        <div className="text-xs font-mono uppercase tracking-[0.2em] text-accent">
          Logo Final · Manrope 700 · 48px / 1.04em
        </div>
        <h1 className="mt-2 text-4xl font-bold tracking-tight">
          tom.Quest logotype
        </h1>
        <p className="mt-4 text-text-muted max-w-3xl leading-relaxed">
          Two variants, both scaled and recolored. In <span className="font-mono text-xs">bars</span> mode
          the lowercase <span className="font-mono text-xs">t</span> crossbars are removed and stems
          extended upward; the top bar continues the symbol&apos;s internal T-crossbar out to both
          ends; the underline sits flush with the baseline.
        </p>
      </header>

      {/* Hero */}
      <section className="mt-12 rounded-md border border-border bg-surface p-10 flex flex-col items-center gap-10">
        <TomLogo fontSize={120} variant="plain" />
        <TomLogo fontSize={120} variant="bars"  />
      </section>

      {/* Size ladder — two columns */}
      <section className="mt-12">
        <div className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted mb-4">
          size ladder
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(["plain", "bars"] as const).map((variant) => (
            <div key={variant} className="rounded-md border border-border bg-surface p-6 flex flex-col gap-6">
              <div className="text-xs font-mono text-text-muted">{variant}</div>
              {SIZES.map((s) => (
                <div key={s} className="flex items-baseline gap-6">
                  <span className="text-[10px] font-mono text-text-faint w-12 shrink-0">{s}px</span>
                  <TomLogo fontSize={s} variant={variant} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* Color swatches */}
      <section className="mt-12">
        <div className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted mb-4">
          color swatches · 72px
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {(["plain", "bars"] as const).map((variant) => (
            <div key={variant} className="flex flex-col gap-3">
              <div className="text-xs font-mono text-text-muted">{variant}</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {SWATCHES.map((s) => (
                  <div
                    key={s.label}
                    className="rounded-md border border-border p-5 flex flex-col items-start gap-3"
                    style={{ background: s.bg }}
                  >
                    <div
                      className="text-[10px] font-mono uppercase tracking-wider"
                      style={{ color: s.color, opacity: 0.7 }}
                    >
                      {s.label}
                    </div>
                    <TomLogo fontSize={72} variant={variant} color={s.color} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Thumbnail / favicon scale */}
      <section className="mt-12 rounded-md border border-border bg-surface p-6">
        <div className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted mb-4">
          small & monochrome
        </div>
        <div className="flex flex-wrap items-baseline gap-8">
          {[16, 20, 28].map((s) => (
            <div key={s} className="flex items-baseline gap-3">
              <span className="text-[10px] font-mono text-text-faint">{s}px</span>
              <TomLogo fontSize={s} variant="bars" />
              <TomLogo fontSize={s} variant="plain" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
