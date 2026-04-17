/* Pure-geometry tom-symbol renderer.
   Baseline = outer-bottom of Q (includes stroke). Dash + dot auto-land on it.
   variant "full" = Q + tom-symbol (dot + horizontal Q-tail, per options).
   variant "pure" = tom symbol only (no dot, right diagonal ends at the circle). */

export type TomSymbolParams = {
  tHeight: number;
  mAngle:  number;
  stroke:  number;
  dotSize: number;
};

export type TomSymbolOptions = {
  dotShape:     "square" | "circle";
  tailCut:      "perpendicular" | "horizontal";
  showBaseline?: "on" | "off";
};

export type TomSymbolVariant = "full" | "pure";

export const TOM_SYMBOL_VB = { w: 640, h: 540 };
const CX = 320;
const CY = 270;
const R  = 170;

export const DEFAULT_TOM_PARAMS: TomSymbolParams = {
  tHeight: -78,
  mAngle:  38,
  stroke:  43,
  dotSize: 60,
};

export const DEFAULT_TOM_OPTIONS: TomSymbolOptions = {
  dotShape:     "circle",
  tailCut:      "horizontal",
  showBaseline: "off",
};

function derive(p: TomSymbolParams, opt: TomSymbolOptions) {
  const barY    = CY + p.tHeight;
  const chordSq = R * R - p.tHeight * p.tHeight;
  const barHalf = chordSq > 0 ? Math.sqrt(chordSq) : 0;

  const aR   = (p.mAngle * Math.PI) / 180;
  const sinA = Math.sin(aR);
  const cosA = Math.cos(aR);
  const w    = p.stroke;

  const baseY = CY + R + w / 2;

  const disc    = Math.max(0, R * R - p.tHeight * p.tHeight * sinA * sinA);
  const tCircle = -p.tHeight * cosA + Math.sqrt(disc);

  const tTailPerp  = cosA !== 0 ? (baseY - barY - sinA * w / 2) / cosA : 0;
  const tTailHoriz = cosA !== 0 ? (baseY - barY)                  / cosA : 0;
  const L = opt.tailCut === "horizontal" ? tTailHoriz : tTailPerp;

  const tDot = cosA !== 0 ? (baseY - barY - p.dotSize / 2) / cosA : 0;

  const leftEnd  = { x: CX - tCircle * sinA, y: barY + tCircle * cosA };
  const rightEnd = { x: CX + L * sinA,       y: barY + L * cosA       };
  const rightEndCircle = { x: CX + tCircle * sinA, y: barY + tCircle * cosA };
  const dotCentre = { x: CX - tDot * sinA, y: barY + tDot * cosA };

  const tanA = cosA !== 0 ? sinA / cosA : 0;
  const tU = L + tanA * w / 2;
  const tL = L - tanA * w / 2;
  const tipY = barY + L * cosA;
  const upperStart = { x: CX + cosA * w / 2, y: barY - sinA * w / 2 };
  const lowerStart = { x: CX - cosA * w / 2, y: barY + sinA * w / 2 };
  const upperTip   = { x: CX + tU * sinA + cosA * w / 2, y: tipY };
  const lowerTip   = { x: CX + tL * sinA - cosA * w / 2, y: tipY };

  return {
    barY,
    barLeftX:  CX - barHalf,
    barRightX: CX + barHalf,
    baseY,
    leftEnd,
    rightEnd,
    rightEndCircle,
    dotCentre,
    tailPoly: [upperStart, upperTip, lowerTip, lowerStart],
  };
}

export default function TomSymbol({
  params = DEFAULT_TOM_PARAMS,
  options = DEFAULT_TOM_OPTIONS,
  variant = "full",
}: {
  params?: TomSymbolParams;
  options?: TomSymbolOptions;
  variant?: TomSymbolVariant;
}) {
  const d = derive(params, options);
  const w = params.stroke;
  const isPure = variant === "pure";
  return (
    <>
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="currentColor" strokeWidth={w} />
      <line x1={d.barLeftX} y1={d.barY} x2={d.barRightX} y2={d.barY} stroke="currentColor" strokeWidth={w} />
      <line x1={CX} y1={d.barY} x2={CX} y2={CY + R} stroke="currentColor" strokeWidth={w} />
      <line x1={CX} y1={d.barY} x2={d.leftEnd.x} y2={d.leftEnd.y} stroke="currentColor" strokeWidth={w} />
      {isPure ? (
        <line x1={CX} y1={d.barY} x2={d.rightEndCircle.x} y2={d.rightEndCircle.y}
          stroke="currentColor" strokeWidth={w} />
      ) : options.tailCut === "horizontal" ? (
        <polygon points={d.tailPoly.map((pt) => `${pt.x},${pt.y}`).join(" ")} fill="currentColor" />
      ) : (
        <line x1={CX} y1={d.barY} x2={d.rightEnd.x} y2={d.rightEnd.y} stroke="currentColor" strokeWidth={w} />
      )}
      {options.showBaseline === "on" && (
        <line x1={40} y1={d.baseY} x2={TOM_SYMBOL_VB.w - 40} y2={d.baseY}
          stroke="currentColor" strokeWidth={1} strokeDasharray="6 6" opacity={0.4} />
      )}
      {!isPure && (
        options.dotShape === "circle" ? (
          <circle cx={d.dotCentre.x} cy={d.dotCentre.y} r={params.dotSize / 2} fill="currentColor" />
        ) : (
          <rect x={d.dotCentre.x - params.dotSize / 2} y={d.dotCentre.y - params.dotSize / 2}
            width={params.dotSize} height={params.dotSize} fill="currentColor" />
        )
      )}
    </>
  );
}
