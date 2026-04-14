import Link from "next/link";

const VARIANTS = [
  {
    href: "/mockups/symbol/sigil",
    name: "Sigil",
    blurb: "Molten amber strokes on a void. Ritual inscription.",
    swatch: "linear-gradient(135deg,#e8a040,#8a4a10)",
  },
  {
    href: "/mockups/symbol/blueprint",
    name: "Blueprint",
    blurb: "Drafting-table precision. Tick marks, annotations, graph paper.",
    swatch: "linear-gradient(135deg,#bee1f5,#3a6a90)",
  },
  {
    href: "/mockups/symbol/arcade",
    name: "Arcade",
    blurb: "Neon CRT phosphor. Magenta circle, cyan line, scanlines.",
    swatch: "linear-gradient(135deg,#ff2bb3,#50e6ff)",
  },
];

export default function SymbolMockupsIndex() {
  return (
    <div className="min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center px-6 py-16">
      <p className="font-mono text-[0.65rem] tracking-[0.35em] uppercase text-accent/50 mb-3">
        Symbol Game · 3 Aesthetics
      </p>
      <h1 className="font-display text-4xl font-bold mb-2">Pick a flavor</h1>
      <p className="text-text-muted mb-12 text-center max-w-md">
        Same game, three wildly different looks. Same fixes: thicker matching strokes,
        line-shaped arrow, travel-time projectile, glowing focal point.
      </p>

      <ul className="grid gap-5 w-full max-w-xl">
        {VARIANTS.map((v) => (
          <li key={v.href}>
            <Link
              href={v.href}
              className="flex items-center gap-5 p-5 rounded-lg border border-border hover:border-accent bg-surface/50 hover:bg-surface transition-colors"
            >
              <div
                className="w-14 h-14 rounded-md flex-shrink-0"
                style={{ background: v.swatch, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)" }}
              />
              <div className="flex-1">
                <div className="font-display text-xl text-accent">{v.name}</div>
                <div className="mt-1 text-sm text-text-muted">{v.blurb}</div>
                <div className="mt-2 text-xs font-mono text-text-faint">{v.href}</div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
