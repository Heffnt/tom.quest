"use client";

import { useState } from "react";
import TomLogo from "../components/tom-logo";
import TomSymbol, { type TomSymbolOptions, type TomSymbolParams } from "../components/tom-symbol";

const SIZES = [24, 36, 48, 72, 120];
const SWATCHES = [
  { label: "default", bg: "var(--color-bg)", color: "var(--color-text)", symbol: "var(--color-accent)" },
  { label: "surface", bg: "var(--color-surface)", color: "var(--color-text)", symbol: "var(--color-accent)" },
  { label: "mono accent", bg: "var(--color-bg)", color: "var(--color-accent)", symbol: "var(--color-accent)" },
  { label: "inverted", bg: "var(--color-text)", color: "var(--color-bg)", symbol: "var(--color-bg)" },
  { label: "accent bg", bg: "var(--color-accent)", color: "var(--color-bg)", symbol: "var(--color-bg)" },
];

const DEFAULT_PARAMS: TomSymbolParams = {
  tHeight: -78,
  mAngle: 38,
  stroke: 43,
  dotSize: 60,
};

const DEFAULT_OPTIONS: TomSymbolOptions = {
  dotShape: "circle",
  tailCut: "horizontal",
  showBaseline: "off",
};

function ParamSlider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block rounded-lg border border-border bg-surface/50 p-4">
      <span className="flex items-center justify-between gap-3 text-sm">
        <span className="text-text-muted">{label}</span>
        <span className="font-mono text-accent">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-3 w-full"
      />
    </label>
  );
}

export default function LogoLab() {
  const [params, setParams] = useState<TomSymbolParams>(DEFAULT_PARAMS);
  const [options, setOptions] = useState<TomSymbolOptions>(DEFAULT_OPTIONS);

  const updateParam = (key: keyof TomSymbolParams, value: number) => {
    setParams((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <header>
        <div className="font-mono text-xs uppercase tracking-[0.2em] text-accent">Logo Lab</div>
        <h1 className="mt-2 text-4xl font-bold tracking-tight">tom.Quest mark system</h1>
        <p className="mt-3 max-w-2xl text-text-muted">
          Tune the symbol geometry and immediately see how it behaves as an icon,
          wordmark, tiny nav mark, and color-system asset.
        </p>
      </header>

      <div className="mt-10 grid gap-8 lg:grid-cols-[360px_1fr]">
        <section className="space-y-4">
          <ParamSlider label="T-bar height" value={params.tHeight} min={-130} max={-20} onChange={(value) => updateParam("tHeight", value)} />
          <ParamSlider label="M angle" value={params.mAngle} min={20} max={55} onChange={(value) => updateParam("mAngle", value)} />
          <ParamSlider label="Stroke" value={params.stroke} min={24} max={68} onChange={(value) => updateParam("stroke", value)} />
          <ParamSlider label="Dot size" value={params.dotSize} min={24} max={96} onChange={(value) => updateParam("dotSize", value)} />
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setOptions((current) => ({ ...current, dotShape: current.dotShape === "circle" ? "square" : "circle" }))}
              className="rounded-lg border border-border bg-surface/50 p-3 text-sm text-text-muted hover:border-accent hover:text-text"
            >
              dot: {options.dotShape}
            </button>
            <button
              type="button"
              onClick={() => setOptions((current) => ({ ...current, tailCut: current.tailCut === "horizontal" ? "perpendicular" : "horizontal" }))}
              className="rounded-lg border border-border bg-surface/50 p-3 text-sm text-text-muted hover:border-accent hover:text-text"
            >
              tail: {options.tailCut}
            </button>
          </div>
        </section>

        <section className="space-y-8">
          <div className="rounded-2xl border border-border bg-surface/40 p-8">
            <div className="grid items-center gap-8 md:grid-cols-[220px_1fr]">
              <svg viewBox="0 0 640 540" className="h-auto w-full text-accent">
                <TomSymbol params={params} options={options} />
              </svg>
              <div className="space-y-5">
                <TomLogo fontSize={72} variant="plain" symbolParams={params} symbolOptions={options} />
                <TomLogo fontSize={72} variant="bars" symbolParams={params} symbolOptions={options} />
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-surface/40 p-6">
            <h2 className="mb-5 text-xl font-semibold">Size ladder</h2>
            <div className="space-y-5">
              {SIZES.map((size) => (
                <div key={size} className="flex items-center gap-5">
                  <span className="w-12 font-mono text-xs text-text-faint">{size}px</span>
                  <TomLogo fontSize={size} variant="plain" symbolParams={params} symbolOptions={options} />
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {SWATCHES.map((swatch) => (
              <div key={swatch.label} className="rounded-2xl border border-border p-5" style={{ background: swatch.bg }}>
                <div className="mb-4 font-mono text-xs uppercase tracking-[0.16em]" style={{ color: swatch.color }}>
                  {swatch.label}
                </div>
                <TomLogo
                  fontSize={44}
                  textColor={swatch.color}
                  symbolColor={swatch.symbol}
                  symbolParams={params}
                  symbolOptions={options}
                />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
