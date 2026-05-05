"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Manrope } from "next/font/google";
import TomSymbol, { type TomSymbolOptions, type TomSymbolParams } from "./tom-symbol";

const manrope = Manrope({ subsets: ["latin"], weight: ["700"], display: "swap" });
const MANROPE_FAMILY = manrope.style.fontFamily;

/* Cropped symbol viewBox — matches default stroke=43.
   y=78.5 is circle-top outer edge; y=461.5 is baseline; width 500 pads the
   dot/tail extent (x∈[103,552] → [70,570]).                               */
const SYMBOL_VB_X = 70;
const SYMBOL_VB_Y = 78.5;
const SYMBOL_VB_W = 500;
const SYMBOL_VB_H = 383;

const TOP_BAR_FRAC    = 269.5 / 383;
const STROKE_VB       = 43;
const STROKE_FRAC     = STROKE_VB / SYMBOL_VB_H;
const SYMBOL_AR       = SYMBOL_VB_W / SYMBOL_VB_H;
const SYMBOL_HEIGHT_EM = 1.04;
const FONT_WEIGHT      = 700;

const DEFAULT_TEXT_COLOR   = "#ffffff";
const DEFAULT_SYMBOL_COLOR = "#e8a040"; // --color-accent

export type TomLogoVariant = "plain" | "bars";

type TomLogoProps = {
  fontSize: number;
  variant?: TomLogoVariant;
  /** When provided, both text and symbol use this color (mono mode). */
  color?: string;
  /** Overrides text color. Falls back to `color`, then default white. */
  textColor?: string;
  /** Overrides symbol color. Falls back to `color`, then default amber. */
  symbolColor?: string;
  symbolParams?: TomSymbolParams;
  symbolOptions?: TomSymbolOptions;
  className?: string;
  title?: string;
};

function fontReady(fontSize: number): Promise<unknown> {
  if (typeof document === "undefined" || !document.fonts) {
    return Promise.resolve();
  }
  return Promise.all([
    document.fonts.load(`${FONT_WEIGHT} ${fontSize}px ${MANROPE_FAMILY}`),
    document.fonts.ready,
  ]);
}

export default function TomLogo({
  fontSize,
  variant = "plain",
  color,
  textColor,
  symbolColor,
  symbolParams,
  symbolOptions,
  className,
  title   = "tom.Quest",
}: TomLogoProps) {
  const resolvedText   = textColor   ?? color ?? DEFAULT_TEXT_COLOR;
  const resolvedSymbol = symbolColor ?? color ?? DEFAULT_SYMBOL_COLOR;

  const tRef   = useRef<HTMLSpanElement>(null);
  const omRef  = useRef<HTMLSpanElement>(null);
  const uesRef = useRef<HTMLSpanElement>(null);

  // Manrope 700 character-width ratios (measured empirically).
  // Used as immediate fallback so the logo is always visible; refined once
  // the real font loads and getBoundingClientRect returns accurate values.
  const estimate = (fs: number) => ({ t: fs * 0.547, om: fs * 1.305, ues: fs * 1.453 });
  const [m, setM] = useState(() => estimate(fontSize));

  useLayoutEffect(() => {
    setM(estimate(fontSize));
    let cancelled = false;
    void fontReady(fontSize).then(() => {
      if (cancelled || !tRef.current || !omRef.current || !uesRef.current) return;
      const t   = tRef.current.getBoundingClientRect().width;
      const om  = omRef.current.getBoundingClientRect().width;
      const ues = uesRef.current.getBoundingClientRect().width;
      if (t > 0 && om > 0 && ues > 0) setM({ t, om, ues });
    });
    return () => { cancelled = true; };
  }, [fontSize]);

  const probes = (
    <span aria-hidden style={{ position: "absolute", visibility: "hidden", whiteSpace: "pre", top: -9999, left: -9999 }}>
      <span ref={tRef}   className={manrope.className} style={{ fontSize, fontWeight: FONT_WEIGHT, lineHeight: 1 }}>t</span>
      <span ref={omRef}  className={manrope.className} style={{ fontSize, fontWeight: FONT_WEIGHT, lineHeight: 1 }}>om</span>
      <span ref={uesRef} className={manrope.className} style={{ fontSize, fontWeight: FONT_WEIGHT, lineHeight: 1 }}>ues</span>
    </span>
  );

  const symbolH  = SYMBOL_HEIGHT_EM * fontSize;
  const symbolW  = symbolH * SYMBOL_AR;
  const barThick = STROKE_FRAC   * symbolH;
  const topBarY  = TOP_BAR_FRAC  * symbolH;
  const stemW    = barThick;

  const padX = barThick * 0.25;
  let x = padX;
  const leftTX  = x;
  const leftTW  = variant === "bars" ? stemW : m.t;
  x += leftTW;
  const omX     = x;
  x += m.om;
  const symX    = x;
  x += symbolW;
  const uesX    = x;
  x += m.ues;
  const rightTX = x;
  const rightTW = variant === "bars" ? stemW : m.t;
  x += rightTW;
  const totalW  = x + padX;

  const baselineY  = symbolH;
  const bottomBarH = variant === "bars" ? barThick : 0;
  const svgH       = symbolH + bottomBarH;

  const fullBarX1 = leftTX;
  const fullBarX2 = rightTX + rightTW;

  return (
    <span className={className} style={{ display: "inline-block", lineHeight: 0, maxWidth: "100%" }}>
      {probes}
      <svg
        role="img"
        aria-label={title}
        width={totalW}
        height={svgH}
        viewBox={`0 0 ${totalW} ${svgH}`}
        style={{ display: "block", overflow: "visible", maxWidth: "100%", height: "auto" }}
      >
        <text
          x={omX} y={baselineY}
          fontFamily={MANROPE_FAMILY}
          fontWeight={FONT_WEIGHT}
          fontSize={fontSize}
          fill={resolvedText}
          dominantBaseline="alphabetic"
        >
          om
        </text>

        {/* Symbol uses its own color via a wrapping <g color> so <TomSymbol>'s
            currentColor paints strictly the Q. */}
        <g color={resolvedSymbol}>
          <svg
            x={symX}
            y={baselineY - symbolH}
            width={symbolW}
            height={symbolH}
            viewBox={`${SYMBOL_VB_X} ${SYMBOL_VB_Y} ${SYMBOL_VB_W} ${SYMBOL_VB_H}`}
            overflow="visible"
          >
            <TomSymbol params={symbolParams} options={symbolOptions} />
          </svg>
        </g>

        <text
          x={uesX} y={baselineY}
          fontFamily={MANROPE_FAMILY}
          fontWeight={FONT_WEIGHT}
          fontSize={fontSize}
          fill={resolvedText}
          dominantBaseline="alphabetic"
        >
          ues
        </text>

        {variant === "plain" ? (
          <>
            <text x={leftTX}  y={baselineY} fontFamily={MANROPE_FAMILY} fontWeight={FONT_WEIGHT} fontSize={fontSize} fill={resolvedText}>t</text>
            <text x={rightTX} y={baselineY} fontFamily={MANROPE_FAMILY} fontWeight={FONT_WEIGHT} fontSize={fontSize} fill={resolvedText}>t</text>
          </>
        ) : (
          <>
            <rect x={leftTX}  y={baselineY - topBarY - barThick / 2} width={stemW} height={topBarY + barThick / 2} fill={resolvedText} />
            <rect x={rightTX} y={baselineY - topBarY - barThick / 2} width={stemW} height={topBarY + barThick / 2} fill={resolvedText} />
            <rect x={fullBarX1} y={baselineY - topBarY - barThick / 2} width={fullBarX2 - fullBarX1} height={barThick} fill={resolvedText} />
            <rect x={fullBarX1} y={baselineY}                          width={fullBarX2 - fullBarX1} height={barThick} fill={resolvedText} />
          </>
        )}
      </svg>
    </span>
  );
}
