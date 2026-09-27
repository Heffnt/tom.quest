// The frame's rules as pure functions, so the page and its tests read the same
// ones: which edge a key names, which key is text, which open drawer Escape
// closes first, how big a drawer may be, how two drawers on one axis share it,
// what a drag of a handle does, and where each drawer's box lies.

export type Edge = "top" | "bottom" | "left" | "right";

export type OpenState = Partial<Record<Edge, boolean>>;

export const EDGES: readonly Edge[] = ["top", "left", "right", "bottom"];

/** The thickness of every handle, in pixels: the same on all four edges. */
export const HANDLE_PX = 28;

/** The height of the site header, which spans the full width above everything else. */
export const HEADER_PX = 40;

/** W, A, S and D toggle the top, left, bottom and right drawers. */
export const EDGE_FOR_KEY: Readonly<Record<string, Edge>> = { w: "top", a: "left", s: "bottom", d: "right" };

export type Side = "left" | "right";
export type End = "top" | "bottom";

/** The drawer across the screen from this one. */
export const OPPOSITE: Readonly<Record<Edge, Edge>> = { left: "right", right: "left", top: "bottom", bottom: "top" };

/**
 * The order Escape closes open drawers in: the top, then the side opened
 * last, then the other side, then the bottom.
 */
export function closeOrder(lastSide: Side): Edge[] {
  return ["top", lastSide, lastSide === "left" ? "right" : "left", "bottom"];
}

/** The open drawer an Escape closes, or null when none is open. */
export function nextToClose(open: OpenState, lastSide: Side = "right"): Edge | null {
  return closeOrder(lastSide).find((edge) => open[edge]) ?? null;
}

/** A length along a drawer's axis: pixels, or a percentage of the room along that axis. */
export type Length = number | `${number}%`;

export type Bounds = { min: Length; max: Length };

export const DEFAULT_BOUNDS: Bounds = { min: 160, max: "85%" };
export const DEFAULT_SIZE = 320;

/** Movement under this many pixels is a click on the handle, not a drag. */
export const CLICK_SLOP = 4;

function px(length: Length, axis: number): number {
  return typeof length === "number" ? length : (parseFloat(length) / 100) * axis;
}

/**
 * How much of an axis two opposite drawers may take together: the room on
 * that axis less three handles, their own two and one more, so the handles of
 * the drawers between them never shrink to nothing. `axis` is the width of
 * the screen for the sides, and its height under the header for the top and
 * bottom.
 */
export function shared(axis: number, handle = HANDLE_PX): number {
  return Math.max(0, axis - 3 * handle);
}

/**
 * A drawer's bounds in pixels on an axis `axis` pixels long. However the page
 * set them, a drawer never takes more than the axis's shared room (so its own
 * handle never meets the opposite one), and its minimum never exceeds its
 * maximum.
 */
export function resolveBounds(bounds: Bounds, axis: number, handle = HANDLE_PX): { min: number; max: number } {
  const hardMax = shared(axis, handle);
  const max = Math.min(Math.max(px(bounds.max, axis), px(bounds.min, axis)), hardMax);
  const min = Math.min(px(bounds.min, axis), max);
  return { min: Math.round(min), max: Math.round(max) };
}

export function clamp(size: number, { min, max }: { min: number; max: number }): number {
  return Math.round(Math.min(max, Math.max(min, size)));
}

/**
 * How far a pointer has pulled a drawer out from its edge, from where the drag
 * started. Pulling toward the center is positive on every edge.
 */
export function pullDistance(edge: Edge, dx: number, dy: number): number {
  switch (edge) {
    case "left":
      return dx;
    case "right":
      return -dx;
    case "top":
      return dy;
    case "bottom":
      return -dy;
  }
}

/** The size a drawer shows mid-drag: it follows the pointer from fully shut up to its maximum. */
export function dragSize(raw: number, bounds: { min: number; max: number }): number {
  return Math.round(Math.min(bounds.max, Math.max(0, raw)));
}

/**
 * Where a released drag leaves a drawer. Let go under half its minimum and it
 * shuts; anywhere else it stays open, at the pointer's size clamped to its
 * bounds.
 */
export function releaseDrag(raw: number, bounds: { min: number; max: number }): { open: boolean; size: number } {
  if (raw < bounds.min / 2) return { open: false, size: Math.max(0, Math.round(raw)) };
  return { open: true, size: clamp(raw, bounds) };
}

/** One drawer as the sharing rule sees it. */
export type DrawerWish = {
  present: boolean;
  open: boolean;
  /** The size it opens at, already within its bounds. */
  size: number;
  bounds: { min: number; max: number };
};

/**
 * How two opposite drawers share an axis: the size each shows, 0 for shut.
 * They never overlap. `first` has the room first (the one being dragged, else
 * the one opened last); `second` gives way down to its minimum, and past that
 * `first` stops. When the two minimums cannot both fit (a phone), `second`
 * shuts. A dragged `first` passes `dragged`, its size under the pointer,
 * which may be anywhere from 0 to its maximum; then `second` shuts only once
 * `first` is pulled past half its minimum, where letting go would leave it
 * open.
 */
export function sharePair(
  first: DrawerWish,
  second: DrawerWish,
  room: number,
  dragged?: number,
): { first: number; second: number; secondShut: boolean } {
  const firstShown = first.present && (dragged !== undefined || first.open);
  let a = !firstShown ? 0 : dragged !== undefined ? Math.min(dragged, first.bounds.max) : first.size;
  const secondShown = second.present && second.open;
  if (!secondShown) return { first: Math.min(a, room), second: 0, secondShut: false };
  const firstWillOpen = dragged !== undefined ? dragged >= first.bounds.min / 2 : firstShown;
  if (firstWillOpen && first.bounds.min + second.bounds.min > room) {
    return { first: Math.min(a, room), second: 0, secondShut: true };
  }
  let b = Math.min(second.size, room - a);
  if (b < second.bounds.min) {
    b = second.bounds.min;
    a = Math.max(0, room - b);
  }
  return { first: Math.round(a), second: Math.round(b), secondShut: false };
}

/**
 * Where a drawer's box lies inside the stage (the area under the header), as
 * the CSS properties to write. `shown` is how far it is pulled out, `min` its
 * minimum. The box is its body at max(shown, min) plus its handle, so a drawer
 * pulled out less than its minimum slides, keeping its content at the
 * minimum width, and past it, it grows; the part past the stage's edge is
 * clipped. A side drawer runs the full height of the stage. The top and
 * bottom drawers run between the side drawers: `leftExtent` and
 * `rightExtent` are how far the side drawers reach in from the edges,
 * handles included.
 */
export function drawerBox(
  edge: Edge,
  shown: number,
  min: number,
  leftExtent: number,
  rightExtent: number,
  handle = HANDLE_PX,
): Record<string, string> {
  const body = Math.max(shown, min);
  const hidden = `${shown - body}px`;
  const length = `${body + handle}px`;
  switch (edge) {
    case "left":
      return { left: hidden, width: length };
    case "right":
      return { right: hidden, width: length };
    case "top":
      return { top: hidden, height: length, left: `${leftExtent}px`, right: `${rightExtent}px` };
    case "bottom":
      return { bottom: hidden, height: length, left: `${leftExtent}px`, right: `${rightExtent}px` };
  }
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
