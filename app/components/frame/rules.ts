// The frame's rules as pure functions, so the page and its tests read the same
// ones: which edge a key names, which key is text, which open drawer is on
// top, how big a drawer may be, and what a drag of its handle does.

export type Edge = "top" | "bottom" | "left" | "right";

export type OpenState = Partial<Record<Edge, boolean>>;

export const EDGES: readonly Edge[] = ["top", "left", "right", "bottom"];

/** W, A, S and D toggle the top, left, bottom and right drawers. */
export const EDGE_FOR_KEY: Readonly<Record<string, Edge>> = { w: "top", a: "left", s: "bottom", d: "right" };

/**
 * The layer order, topmost first. Corners go top, then sides, then bottom
 * (the way VS Code lays out its title bar, side bars and panel): the top
 * drawer spans the full width over the sides, the sides run the full height
 * below it over the bottom's ends, and the bottom sits between them. Between
 * the two sides, the one opened last lies on top. globals.css holds the same
 * order as the --z-drawer-* tokens; frame.test.tsx holds the two together.
 */
export function layerOrder(lastSide: "left" | "right"): Edge[] {
  return ["top", lastSide, lastSide === "left" ? "right" : "left", "bottom"];
}

/** The open drawer an Escape closes, or null when none is open. */
export function topmostOpen(open: OpenState, lastSide: "left" | "right" = "right"): Edge | null {
  return layerOrder(lastSide).find((edge) => open[edge]) ?? null;
}

/** A length along a drawer's axis: pixels, or a percentage of the viewport along that axis. */
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
 * A drawer's bounds in pixels for a viewport `axis` pixels long in its
 * direction, with handles `handle` pixels thick. However the page set them, a
 * drawer never grows past the point where its own handle and the opposite
 * one would touch, and its minimum never exceeds its maximum.
 */
export function resolveBounds(bounds: Bounds, axis: number, handle: number): { min: number; max: number } {
  const hardMax = Math.max(0, axis - 3 * handle);
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
