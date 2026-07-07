// app/boolback/components/glyph.tsx — the shape-channel glyph cycle, shared by
// the plot body and the dimension board's swatches so both stay in sync.

import type React from "react";
import { SHAPE_COUNT } from "../lib/styling";

/** SVG glyph for a shape-channel index (0 = plain circle; cycles SHAPE_COUNT). */
export function shapeNode(
  idx: number, cx: number, cy: number, r: number,
  props: { fill: string; fillOpacity: number; stroke: string; strokeOpacity: number },
): React.ReactElement {
  const k = ((idx % SHAPE_COUNT) + SHAPE_COUNT) % SHAPE_COUNT;
  if (k === 1) {
    return <rect x={cx - r} y={cy - r} width={2 * r} height={2 * r} {...props} pointerEvents="none" />;
  }
  if (k === 2) {
    return <path d={`M${cx},${cy - r * 1.2} L${cx + r * 1.1},${cy + r * 0.9} L${cx - r * 1.1},${cy + r * 0.9} Z`} {...props} pointerEvents="none" />;
  }
  if (k === 3) {
    return <path d={`M${cx},${cy - r * 1.3} L${cx + r * 1.3},${cy} L${cx},${cy + r * 1.3} L${cx - r * 1.3},${cy} Z`} {...props} pointerEvents="none" />;
  }
  if (k === 4) {
    return <path d={`M${cx},${cy + r * 1.2} L${cx + r * 1.1},${cy - r * 0.9} L${cx - r * 1.1},${cy - r * 0.9} Z`} {...props} pointerEvents="none" />;
  }
  if (k === 5) {
    const a = r * 0.9;
    return (
      <path
        d={`M${cx - a},${cy - a} L${cx + a},${cy + a} M${cx - a},${cy + a} L${cx + a},${cy - a}`}
        fill="none" stroke={props.stroke} strokeOpacity={props.strokeOpacity}
        strokeWidth={Math.max(1.5, r * 0.5)} pointerEvents="none"
      />
    );
  }
  return <circle cx={cx} cy={cy} r={r} {...props} pointerEvents="none" />;
}
