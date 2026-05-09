"use client";

import type { CSSProperties } from "react";
import TomSymbol, { TOM_SYMBOL_VB } from "./tom-symbol";

type TomQuestSymbolProps = {
  size?: number;
  color?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
};

export default function TomQuestSymbol({
  size = 32,
  color = "var(--color-accent)",
  className,
  style,
  title = "tom.Quest",
}: TomQuestSymbolProps) {
  return (
    <svg
      role="img"
      aria-label={title}
      viewBox={`0 0 ${TOM_SYMBOL_VB.w} ${TOM_SYMBOL_VB.h}`}
      width={size}
      height={size * (TOM_SYMBOL_VB.h / TOM_SYMBOL_VB.w)}
      className={className}
      style={{ color, display: "block", overflow: "visible", ...style }}
    >
      <TomSymbol />
    </svg>
  );
}
