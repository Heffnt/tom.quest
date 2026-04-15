"use client";

import { useEffect, useRef, useState } from "react";
import { Manrope } from "next/font/google";
import TomSymbol from "./tom-symbol";

const manrope = Manrope({ subsets: ["latin"], weight: ["700"], display: "swap" });
const MANROPE_FAMILY = manrope.style.fontFamily;

/* Cropped symbol viewBox — matches default stroke=43.
   y=78.5 is circle-top outer edge; y=461.5 is baseline; width 500 pads the
   dot/tail extent (x∈[103,552] → [70,570]).                               */
const SYMBOL_VB_X = 70;
const SYMBOL_VB_Y = 78.5;
const SYMBOL_VB_W = 500;
const SYMBOL_VB_H = 383;

/* Symbol bar (the horizontal T-crossbar inside the Q) sits at VB y=192.
   Distance above baseline in VB units: 461.5 − 192 = 269.5
   → fraction of symbol display height = 269.5 / 383 ≈ 0.70365             */
const TOP_BAR_FRAC    = 269.5 / 383;
const STROKE_VB       = 43;               // matches DEFAULT_TOM_PARAMS.stroke
const STROKE_FRAC     = STROKE_VB / SYMBOL_VB_H;
const SYMBOL_AR       = SYMBOL_VB_W / SYMBOL_VB_H;
const SYMBOL_HEIGHT_EM = 1.04;            // locked selection
const FONT_WEIGHT      = 700;

export type TomLogoVariant = "plain" | "bars";

export default function TomLogo({
  fontSize,
  variant = "plain",
  color   = "currentColor",
  className,
  title   = "tom.Quest",
}: {
  fontSize: number;
  variant?: TomLogoVariant;
  color?:   string;
  className?: string;
  title?:   string;
}) {
  const tRef   = useRef<HTMLSpanElement>(null);
  const omRef  = useRef<HTMLSpanElement>(null);
  const uesRef = useRef<HTMLSpanElement>(null);
  const [m, setM] = useState<{ t: number; om: number; ues: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (cancelled || !tRef.current || !omRef.current || !uesRef.current) return;
      setM({
        t:   tRef.current.getBoundingClientRect().width,
        om:  omRef.current.getBoundingClientRect().width,
        ues: uesRef.current.getBoundingClientRect().width,
      });
    });
    return () => { cancelled = true; };
  }, [fontSize]);

  /* Hidden measurement pass — mount before we can lay out. */
  const probes = (
    <span aria-hidden style={{ position: "absolute", visibility: "hidden", whiteSpace: "pre", top: -9999, left: -9999 }}>
      <span ref={tRef}   className={manrope.className} style={{ fontSize, fontWeight: FONT_WEIGHT, lineHeight: 1 }}>t</span>
      <span ref={omRef}  className={manrope.className} style={{ fontSize, fontWeight: FONT_WEIGHT, lineHeight: 1 }}>om</span>
      <span ref={uesRef} className={manrope.className} style={{ fontSize, fontWeight: FONT_WEIGHT, lineHeight: 1 }}>ues</span>
    </span>
  );

  if (!m) {
    return (
      <span className={className} style={{ display: "inline-block", width: fontSize * 4, height: fontSize * 1.2 }}>
        {probes}
      </span>
    );
  }

  const symbolH  = SYMBOL_HEIGHT_EM * fontSize;
  const symbolW  = symbolH * SYMBOL_AR;
  const barThick = STROKE_FRAC   * symbolH;    // uniform stroke across logo
  const topBarY  = TOP_BAR_FRAC  * symbolH;    // baseline offset for top-bar centre
  const stemW    = barThick;

  /* Horizontal layout: everything x-positioned with baseline at y = symbolH. */
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

  const baselineY  = symbolH;                       // baseline y inside svg
  const bottomBarH = variant === "bars" ? barThick : 0;
  const svgH       = symbolH + bottomBarH;

  const fullBarX1 = leftTX;
  const fullBarX2 = rightTX + rightTW;

  return (
    <span className={className} style={{ display: "inline-block", lineHeight: 0, color }}>
      {probes}
      <svg
        role="img"
        aria-label={title}
        width={totalW}
        height={svgH}
        viewBox={`0 0 ${totalW} ${svgH}`}
        style={{ display: "block", overflow: "visible" }}
      >
        {/* om */}
        <text
          x={omX} y={baselineY}
          fontFamily={MANROPE_FAMILY}
          fontWeight={FONT_WEIGHT}
          fontSize={fontSize}
          fill="currentColor"
          dominantBaseline="alphabetic"
        >
          om
        </text>

        {/* tom-symbol — nested svg keeps its cropped viewBox intact */}
        <svg
          x={symX}
          y={baselineY - symbolH}
          width={symbolW}
          height={symbolH}
          viewBox={`${SYMBOL_VB_X} ${SYMBOL_VB_Y} ${SYMBOL_VB_W} ${SYMBOL_VB_H}`}
          overflow="visible"
        >
          <TomSymbol />
        </svg>

        {/* ues */}
        <text
          x={uesX} y={baselineY}
          fontFamily={MANROPE_FAMILY}
          fontWeight={FONT_WEIGHT}
          fontSize={fontSize}
          fill="currentColor"
          dominantBaseline="alphabetic"
        >
          ues
        </text>

        {variant === "plain" ? (
          <>
            <text x={leftTX}  y={baselineY} fontFamily={MANROPE_FAMILY} fontWeight={FONT_WEIGHT} fontSize={fontSize} fill="currentColor">t</text>
            <text x={rightTX} y={baselineY} fontFamily={MANROPE_FAMILY} fontWeight={FONT_WEIGHT} fontSize={fontSize} fill="currentColor">t</text>
          </>
        ) : (
          <>
            {/* Left + right t stems — rise from baseline to top-bar top */}
            <rect
              x={leftTX}
              y={baselineY - topBarY - barThick / 2}
              width={stemW}
              height={topBarY + barThick / 2}
              fill="currentColor"
            />
            <rect
              x={rightTX}
              y={baselineY - topBarY - barThick / 2}
              width={stemW}
              height={topBarY + barThick / 2}
              fill="currentColor"
            />
            {/* Top bar — merges with the symbol's internal T-crossbar line */}
            <rect
              x={fullBarX1}
              y={baselineY - topBarY - barThick / 2}
              width={fullBarX2 - fullBarX1}
              height={barThick}
              fill="currentColor"
            />
            {/* Underline — top flush with baseline */}
            <rect
              x={fullBarX1}
              y={baselineY}
              width={fullBarX2 - fullBarX1}
              height={barThick}
              fill="currentColor"
            />
          </>
        )}
      </svg>
    </span>
  );
}
