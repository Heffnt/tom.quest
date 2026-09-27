// The frame's rules as pure functions, so the page and its tests read the same
// ones: which edge a key names, which key is text, which open drawer is on
// top, and what else closes when a drawer opens.

export type Edge = "top" | "bottom" | "left" | "right";

export type OpenState = Partial<Record<Edge, boolean>>;

/**
 * The layer order, topmost first: right over left over bottom over top. It is
 * fixed by edge, never by the order drawers opened, so the most specific panel
 * (one item, on the right) is never covered by a more general one. Escape
 * closes open drawers in this order. globals.css holds the same order as the
 * --z-drawer-* tokens; frame.test.tsx holds the two together.
 */
export const EDGES_TOPMOST_FIRST: readonly Edge[] = ["right", "left", "bottom", "top"];

/** W, A, S and D toggle the top, left, bottom and right drawers. */
export const EDGE_FOR_KEY: Readonly<Record<string, Edge>> = { w: "top", a: "left", s: "bottom", d: "right" };

/** Below this width the frame is a phone: no side rails, one sheet at a time. */
const PHONE_MAX_WIDTH = 640;
/** Below this width only one side drawer is open at a time. */
const ONE_SIDE_MAX_WIDTH = 1024;
/** The narrowest center two open side drawers may leave. */
const MIN_CENTER_WIDTH = 160;

/** The open drawer an Escape closes, or null when none is open. */
export function topmostOpen(open: OpenState): Edge | null {
  return EDGES_TOPMOST_FIRST.find((edge) => open[edge]) ?? null;
}

/**
 * The open state after one drawer opens or closes. Opening on a phone closes
 * every other drawer (sheets come one at a time). Opening a side drawer closes
 * the other side when the viewport is under 1024px, or when the two together
 * would leave the center narrower than 160px.
 */
export function nextOpenState(
  open: OpenState,
  edge: Edge,
  want: boolean,
  viewport: { width: number; railSide: number; leftWidth: number; rightWidth: number },
): OpenState {
  if (!want) return { ...open, [edge]: false };
  if (viewport.width < PHONE_MAX_WIDTH) return { [edge]: true };
  const next: OpenState = { ...open, [edge]: true };
  if (edge === "left" || edge === "right") {
    const other: Edge = edge === "left" ? "right" : "left";
    const inner = viewport.width - 2 * viewport.railSide;
    const tooNarrow = viewport.leftWidth + viewport.rightWidth > inner - MIN_CENTER_WIDTH;
    if (viewport.width < ONE_SIDE_MAX_WIDTH || tooNarrow) next[other] = false;
  }
  return next;
}

/** A key typed into a field is text, never a frame shortcut. */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(type);
}
