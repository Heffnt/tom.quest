import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOrder,
  dragSize,
  drawerBox,
  nextToClose,
  pullDistance,
  releaseDrag,
  resolveBounds,
  sharePair,
  shared,
  type DrawerWish,
} from "./rules";
import { storedFrameState, useFrameStore } from "./frame-store";
import { prepareExplainer } from "./info";
import Frame from "./frame";

vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ user: null, role: "user", isTom: false }),
  getUsername: () => "",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/frame" }));
vi.mock("../debug-panel", () => ({ Diagnostics: () => null, useDiagnosticsStatus: () => ({ convex: "connected", events: [] }) }));

const wish = (open: boolean, size: number, min = 160, max = 2000): DrawerWish => ({
  present: true,
  open,
  size,
  bounds: { min, max },
});

describe("frame layout rules", () => {
  it("closes open drawers top first, then the side opened last, the other side, the bottom", () => {
    expect(closeOrder("left")).toEqual(["top", "left", "right", "bottom"]);
    expect(closeOrder("right")).toEqual(["top", "right", "left", "bottom"]);
    expect(nextToClose({ top: true, right: true, bottom: true }, "right")).toBe("top");
    expect(nextToClose({ left: true, right: true, bottom: true }, "left")).toBe("left");
    expect(nextToClose({ left: true, right: true, bottom: true }, "right")).toBe("right");
    expect(nextToClose({ bottom: true })).toBe("bottom");
    expect(nextToClose({})).toBeNull();
  });

  it("resolves bounds in pixels and never lets one drawer take more than its axis shares", () => {
    expect(resolveBounds({ min: 160, max: "50%" }, 1440)).toEqual({ min: 160, max: 720 });
    // 390 - 3 * 28 = 306: the page's 85% gives way to the room there is.
    expect(resolveBounds({ min: 160, max: "85%" }, 390)).toEqual({ min: 160, max: 306 });
    expect(resolveBounds({ min: 300, max: 200 }, 1440)).toEqual({ min: 300, max: 300 });
    expect(shared(1440)).toBe(1356);
  });

  it("pulls toward the center as positive on every edge", () => {
    expect(pullDistance("left", 30, 5)).toBe(30);
    expect(pullDistance("right", -30, 5)).toBe(30);
    expect(pullDistance("top", 5, 30)).toBe(30);
    expect(pullDistance("bottom", 5, -30)).toBe(30);
  });

  it("follows the pointer from shut to the maximum, and on release shuts under half the minimum", () => {
    const b = { min: 160, max: 600 };
    expect(dragSize(-40, b)).toBe(0);
    expect(dragSize(250, b)).toBe(250);
    expect(dragSize(900, b)).toBe(600);
    expect(releaseDrag(79, b)).toEqual({ open: false, size: 79 });
    expect(releaseDrag(100, b)).toEqual({ open: true, size: 160 });
    expect(releaseDrag(300, b)).toEqual({ open: true, size: 300 });
    expect(releaseDrag(900, b)).toEqual({ open: true, size: 600 });
  });

  it("gives two opposite drawers their sizes when they fit together", () => {
    expect(sharePair(wish(true, 400), wish(true, 500), 1356)).toEqual({ first: 400, second: 500, secondShut: false });
    expect(sharePair(wish(false, 400), wish(true, 500), 1356)).toEqual({ first: 0, second: 500, secondShut: false });
    expect(sharePair(wish(true, 400), wish(false, 500), 1356)).toEqual({ first: 400, second: 0, secondShut: false });
  });

  it("shrinks the second of two opposite drawers to its minimum, then stops the first", () => {
    // The first wants 900 of 1356: the second gives way from 600 to 456.
    expect(sharePair(wish(true, 900), wish(true, 600), 1356)).toEqual({ first: 900, second: 456, secondShut: false });
    // Dragged to 1300 the first would leave the second 56, under its 160: the second holds 160 and the first stops at 1196.
    expect(sharePair(wish(true, 900), wish(true, 600), 1356, 1300)).toEqual({ first: 1196, second: 160, secondShut: false });
  });

  it("shuts the second drawer where the two minimums cannot both fit, once the first would stay open", () => {
    // A phone: 306 to share, 160 + 160 needed.
    expect(sharePair(wish(true, 200), wish(true, 200), 306)).toEqual({ first: 200, second: 0, secondShut: true });
    // Dragged under half its minimum, the first would shut on release, so the second stays.
    expect(sharePair(wish(false, 200), wish(true, 200), 306, 60)).toEqual({ first: 60, second: 200, secondShut: false });
    expect(sharePair(wish(false, 200), wish(true, 200), 306, 90)).toEqual({ first: 90, second: 0, secondShut: true });
  });

  it("places a drawer's box: a side the full height, the top and bottom between the sides, sliding below the minimum", () => {
    expect(drawerBox("left", 300, 160, 0, 0)).toEqual({ left: "0px", width: "328px" });
    expect(drawerBox("left", 100, 160, 0, 0)).toEqual({ left: "-60px", width: "188px" });
    expect(drawerBox("right", 0, 160, 0, 0)).toEqual({ right: "-160px", width: "188px" });
    expect(drawerBox("top", 200, 160, 328, 28)).toEqual({ top: "0px", height: "228px", left: "328px", right: "28px" });
    expect(drawerBox("bottom", 0, 160, 28, 508)).toEqual({ bottom: "-160px", height: "188px", left: "28px", right: "508px" });
  });
});

describe("explainer viewer head", () => {
  it("forces the dark palette, since an iframe's prefers-color-scheme follows the system", () => {
    const out = prepareExplainer(
      "<head><style>:root { color-scheme: light dark; } @media (prefers-color-scheme: dark) { a{} } @media (prefers-color-scheme: light) { b{} }</style></head>",
    );
    expect(out).toContain("color-scheme: dark;");
    expect(out).toContain("@media all { a{} }");
    expect(out).toContain("@media not all { b{} }");
  });

  it("puts the CSP meta inside <head>, after the doctype", () => {
    const out = prepareExplainer("<!doctype html><html><head><title>x</title></head><body></body></html>");
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  });
});

function renderFrame() {
  const spec = (label: string) => ({ handle: { label }, body: <p>{label} body</p> });
  const pressed = vi.fn();
  render(
    <Frame
      page="test"
      title="Test"
      explainer="frame"
      center={<p>center body</p>}
      top={spec("top drawer")}
      bottom={spec("bottom drawer")}
      left={{ ...spec("left drawer"), handle: { label: "left drawer", actions: [{ label: "refresh", onPress: pressed }] } }}
      right={spec("right drawer")}
    />,
  );
  return { pressed };
}

const drawer = (edge: string) => document.querySelector<HTMLElement>(`[data-frame-drawer="${edge}"]`)!;
const handle = (edge: string) => document.querySelector<HTMLElement>(`[data-frame-handle="${edge}"]`)!;

/** A press on a handle: down and up at one point, as a pointer gives it. */
function press(el: HTMLElement, at = { clientX: 10, clientY: 10 }) {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, ...at });
  fireEvent.pointerUp(el, { pointerId: 1, button: 0, ...at });
}

// jsdom has no PointerEvent, so a fired pointer event would carry no
// position, button or pointer id.
if (typeof window !== "undefined" && !("PointerEvent" in window)) {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
}

describe("<Frame>", () => {
  beforeEach(() => {
    localStorage.clear();
    useFrameStore.setState({ open: {}, size: {}, lastSide: {}, lastEnd: {}, seen: {} });
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = () => {};
  });

  it("puts the site header above the stage, outside every drawer", () => {
    renderFrame();
    const header = document.querySelector("[data-frame-header]")!;
    expect(header.closest("[data-frame-drawer]")).toBeNull();
    expect(header.closest("[data-frame-stage]")).toBeNull();
    expect(screen.getByLabelText("Navigate to a page").closest("[data-frame-header]")).toBe(header);
  });

  it("toggles drawers with W A S D and closes them with Escape: top, the side opened last, the other side, bottom", () => {
    renderFrame();
    act(() => {
      fireEvent.keyDown(window, { key: "s" });
      fireEvent.keyDown(window, { key: "d" });
      fireEvent.keyDown(window, { key: "a" });
      fireEvent.keyDown(window, { key: "w" });
    });
    for (const edge of ["top", "left", "right", "bottom"]) expect(drawer(edge).getAttribute("data-open")).toBe("true");
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      act(() => fireEvent.keyDown(window, { key: "Escape" }));
      order.push(["top", "left", "right", "bottom"].find((e) => drawer(e).getAttribute("data-open") === "false" && !order.includes(e))!);
    }
    expect(order).toEqual(["top", "left", "right", "bottom"]);
  });

  it("ignores the keys while a text field has focus", () => {
    renderFrame();
    const input = screen.getByLabelText("Navigate to a page");
    act(() => fireEvent.keyDown(input, { key: "s" }));
    expect(drawer("bottom").getAttribute("data-open")).toBe("false");
  });

  it("opens a drawer from a press anywhere on its handle, shuts it from the next, and leaves the center untouched", () => {
    renderFrame();
    const center = document.querySelector("[data-frame-center]")!;
    const before = center.outerHTML;
    act(() => press(handle("left")));
    expect(drawer("left").getAttribute("data-open")).toBe("true");
    expect(document.querySelector("[data-frame-center]")).toBe(center);
    expect(center.outerHTML).toBe(before);
    act(() => press(handle("left")));
    expect(drawer("left").getAttribute("data-open")).toBe("false");
  });

  it("keeps a press on a handle's buttons from moving its drawer", () => {
    const { pressed } = renderFrame();
    const button = screen.getByRole("button", { name: "refresh" });
    act(() => press(button));
    act(() => fireEvent.click(button));
    expect(pressed).toHaveBeenCalledTimes(1);
    expect(drawer("left").getAttribute("data-open")).toBe("false");
  });

  it("follows a drag with the drawer's box, and opens to the size it was let go at", () => {
    renderFrame();
    const el = handle("right");
    act(() => {
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 1000, clientY: 300 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 900, clientY: 300 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 700, clientY: 300 });
    });
    expect(drawer("right").getAttribute("data-dragging")).toBe("true");
    expect(drawer("right").style.width).toBe("328px");
    expect(drawer("right").style.right).toBe("0px");
    // The top and bottom drawers end where the right drawer begins.
    expect(drawer("top").style.right).toBe("328px");
    expect(drawer("bottom").style.right).toBe("328px");
    act(() => fireEvent.pointerUp(el, { pointerId: 1, button: 0, clientX: 700, clientY: 300 }));
    expect(drawer("right").getAttribute("data-open")).toBe("true");
    expect(drawer("right").getAttribute("data-dragging")).toBe("false");
    expect(useFrameStore.getState().size.test?.right).toBe(300);
  });

  it("mid-drag, lays each drawer's content out at a width that changes in 40 px steps, never wider than the drawer", () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1000 });
    try {
      renderFrame();
      const scroller = (edge: string) => drawer(edge).querySelector<HTMLElement>("[data-frame-drawer-scroll]")!;
      const el = handle("right");
      act(() => {
        fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 1000, clientY: 300 });
        fireEvent.pointerMove(el, { pointerId: 1, clientX: 700, clientY: 300 });
      });
      // The top drawer lost 300 px on its right: its content is 320 px narrower.
      expect(scroller("top").style.flex).toBe("0 0 680px");
      // The right drawer grew 140 px past its minimum: its content is 120 px wider.
      expect(scroller("right").style.flex).toBe("0 0 1120px");
      // The left drawer did not change: its content fills it.
      expect(scroller("left").style.flex).toBe("");
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
    }
  });

  it("persists the open drawers per page", () => {
    renderFrame();
    act(() => fireEvent.keyDown(window, { key: "a" }));
    expect(useFrameStore.getState().open.test).toEqual({ left: true });
    expect(JSON.parse(localStorage.getItem("tom-quest-frame") ?? "{}").state.open.test).toEqual({ left: true });
  });

  // Earlier rounds on the same preview origin wrote other shapes under the
  // same key; a stored value is never trusted to be the current shape.
  const STORED: [string, string][] = [
    ["round 0 and 1", '{"state":{"open":{"test":{"left":true}},"seen":{"test":{"right":"x"}}},"version":0}'],
    ["round 2", '{"state":{"open":{"test":{"left":true}},"size":{"test":{"left":300}},"lastSide":{"test":"left"},"seen":{}},"version":2}'],
    ["not JSON", "not json{"],
    ["wrong types", '{"state":{"open":null,"size":"x","lastSide":3,"lastEnd":[],"seen":[1]},"version":3}'],
    ["wrong leaves", '{"state":{"open":{"test":"yes"},"size":{"test":{"left":"wide","top":-5}},"lastSide":{"test":"up"},"lastEnd":{"test":"left"},"seen":{"test":7}},"version":3}'],
  ];
  for (const [name, frame] of STORED) {
    it(`reads a stored state that is ${name} as the defaults, without throwing`, async () => {
      localStorage.setItem("tom-quest-frame", frame);
      renderFrame();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(document.querySelectorAll("[data-frame-drawer][data-open=true]")).toHaveLength(0);
      act(() => fireEvent.keyDown(window, { key: "d" }));
      expect(JSON.parse(localStorage.getItem("tom-quest-frame")!).state.open.test).toEqual({ right: true });
    });
  }

  it("restores a well-formed stored state", async () => {
    localStorage.setItem(
      "tom-quest-frame",
      JSON.stringify({ state: { open: { test: { left: true } }, size: { test: { left: 240 } }, lastSide: { test: "left" }, lastEnd: {}, seen: {} }, version: 3 }),
    );
    renderFrame();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(drawer("left").getAttribute("data-open")).toBe("true");
    expect(drawer("left").style.width).toBe("268px");
    expect(useFrameStore.getState().size.test).toEqual({ left: 240 });
  });
});

describe("stored frame state", () => {
  it("keeps only well-formed entries", () => {
    expect(
      storedFrameState({
        open: { a: { left: true, right: "yes", middle: true }, b: null },
        size: { a: { left: 300, right: Number.NaN, top: -1, bottom: "9" } },
        lastSide: { a: "left", b: "up" },
        lastEnd: { a: "top", b: "left" },
        seen: { a: { top: "sig", left: 4 } },
      }),
    ).toEqual({
      open: { a: { left: true } },
      size: { a: { left: 300 } },
      lastSide: { a: "left" },
      lastEnd: { a: "top" },
      seen: { a: { top: "sig" } },
    });
    for (const junk of [undefined, null, 3, "x", [], { open: [] }]) {
      expect(storedFrameState(junk)).toEqual({ open: {}, size: {}, lastSide: {}, lastEnd: {}, seen: {} });
    }
  });
});
