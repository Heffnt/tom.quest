import fs from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dragSize, layerOrder, pullDistance, releaseDrag, resolveBounds, topmostOpen } from "./rules";
import { storedFrameState, useFrameStore } from "./frame-store";
import { storedVariant } from "./variants";
import { prepareExplainer } from "./info";
import Frame from "./frame";

vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ user: null, role: "user", isTom: false }),
  getUsername: () => "",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/tts" }));
vi.mock("../debug-panel", () => ({ Diagnostics: () => null, useDiagnosticsStatus: () => ({ convex: "connected", events: [] }) }));

describe("frame layout rules", () => {
  it("stacks drawers in the order globals.css gives their z layers: top, sides, bottom", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../globals.css"), "utf8");
    const z = (name: string) => Number(new RegExp(`--z-drawer-${name}:\\s*(\\d+)`).exec(css)?.[1]);
    expect(z("top")).toBeGreaterThan(z("side-raised"));
    expect(z("side-raised")).toBeGreaterThan(z("side"));
    expect(z("side")).toBeGreaterThan(z("bottom"));
    expect(layerOrder("left")).toEqual(["top", "left", "right", "bottom"]);
    expect(layerOrder("right")).toEqual(["top", "right", "left", "bottom"]);
  });

  it("closes the topmost open drawer first: top, the side opened last, the other side, bottom", () => {
    expect(topmostOpen({ top: true, right: true, bottom: true }, "right")).toBe("top");
    expect(topmostOpen({ left: true, right: true, bottom: true }, "left")).toBe("left");
    expect(topmostOpen({ left: true, right: true, bottom: true }, "right")).toBe("right");
    expect(topmostOpen({ bottom: true })).toBe("bottom");
    expect(topmostOpen({})).toBeNull();
  });

  it("resolves bounds in pixels and never lets a drawer reach the opposite handle", () => {
    expect(resolveBounds({ min: 160, max: "50%" }, 1440, 28)).toEqual({ min: 160, max: 720 });
    // 390 - 3 * 44 = 258: the page's 85% gives way to the room there is.
    expect(resolveBounds({ min: 160, max: "85%" }, 390, 44)).toEqual({ min: 160, max: 258 });
    expect(resolveBounds({ min: 300, max: 200 }, 1440, 28)).toEqual({ min: 300, max: 300 });
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
  return render(
    <Frame
      page="test"
      title="Test"
      explainer="frame"
      center={<p>center body</p>}
      top={spec("top drawer")}
      bottom={spec("bottom drawer")}
      left={spec("left drawer")}
      right={spec("right drawer")}
    />,
  );
}

const drawer = (edge: string) => document.querySelector(`[data-frame-drawer="${edge}"]`)!;
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
    useFrameStore.setState({ open: {}, size: {}, lastSide: {}, seen: {} });
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = () => {};
  });

  it("toggles drawers with W A S D and closes them with Escape, topmost first", () => {
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
    // The left side opened last, so it lies over the right and closes first.
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
    renderFrame();
    act(() => press(screen.getByRole("radio", { name: "A" })));
    act(() => fireEvent.click(screen.getByRole("radio", { name: "A" })));
    expect(drawer("top").getAttribute("data-open")).toBe("false");
  });

  it("opens a drawer to the size it was dragged to and remembers it", () => {
    renderFrame();
    const el = handle("right");
    act(() => {
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 1000, clientY: 300 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 900, clientY: 300 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 700, clientY: 300 });
    });
    expect(drawer("right").getAttribute("data-dragging")).toBe("true");
    expect((drawer("right") as HTMLElement).style.getPropertyValue("--frame-s")).toBe("300px");
    act(() => fireEvent.pointerUp(el, { pointerId: 1, button: 0, clientX: 700, clientY: 300 }));
    expect(drawer("right").getAttribute("data-open")).toBe("true");
    expect(drawer("right").getAttribute("data-dragging")).toBe("false");
    expect(useFrameStore.getState().size.test?.right).toBe(300);
  });

  it("switches the handle variant with keys 1 and 2, not while typing, and stores it", () => {
    renderFrame();
    const root = document.querySelector<HTMLElement>("[data-frame]")!;
    expect(root.getAttribute("data-frame-variant")).toBe("A");
    expect(root.style.getPropertyValue("--frame-handle")).toBe("28px");
    act(() => fireEvent.keyDown(window, { key: "2" }));
    expect(root.getAttribute("data-frame-variant")).toBe("B");
    expect(root.style.getPropertyValue("--frame-handle")).toBe("44px");
    act(() => fireEvent.keyDown(screen.getByLabelText("Navigate to a page"), { key: "1" }));
    expect(root.getAttribute("data-frame-variant")).toBe("B");
    act(() => fireEvent.click(screen.getByRole("radio", { name: "A" })));
    expect(root.getAttribute("data-frame-variant")).toBe("A");
    expect(JSON.parse(localStorage.getItem("tom-quest-frame-variant") ?? "{}").state.variant).toBe("A");
  });

  it("persists the open drawers per page", () => {
    renderFrame();
    act(() => fireEvent.keyDown(window, { key: "a" }));
    expect(useFrameStore.getState().open.test).toEqual({ left: true });
    expect(JSON.parse(localStorage.getItem("tom-quest-frame") ?? "{}").state.open.test).toEqual({ left: true });
  });

  // Earlier rounds on the same preview origin wrote other shapes under the
  // same keys; a stored value is never trusted to be the current shape.
  const STORED: [string, string, string][] = [
    ["round 0 and 1", '{"state":{"open":{"test":{"left":true}},"seen":{"test":{"right":"x"}}},"version":0}', '{"state":{"variant":"D"},"version":0}'],
    ["not JSON", "not json{", "{"],
    ["wrong types", '{"state":{"open":null,"size":"x","lastSide":3,"seen":[1]},"version":2}', '{"state":null,"version":2}'],
    ["wrong leaves", '{"state":{"open":{"test":"yes"},"size":{"test":{"left":"wide","top":-5}},"lastSide":{"test":"up"},"seen":{"test":7}},"version":2}', '{"state":{"variant":"C"},"version":2}'],
  ];
  for (const [name, frame, variant] of STORED) {
    it(`reads a stored state that is ${name} as the defaults, without throwing`, async () => {
      localStorage.setItem("tom-quest-frame", frame);
      localStorage.setItem("tom-quest-frame-variant", variant);
      renderFrame();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const root = document.querySelector<HTMLElement>("[data-frame]")!;
      expect(root.getAttribute("data-frame-variant")).toBe("A");
      expect(document.querySelectorAll("[data-frame-drawer][data-open=true]")).toHaveLength(0);
      act(() => fireEvent.keyDown(window, { key: "d" }));
      expect(JSON.parse(localStorage.getItem("tom-quest-frame")!).state.open.test).toEqual({ right: true });
    });
  }

  it("restores a well-formed stored state", async () => {
    localStorage.setItem(
      "tom-quest-frame",
      JSON.stringify({ state: { open: { test: { left: true } }, size: { test: { left: 240 } }, lastSide: { test: "left" }, seen: {} }, version: 2 }),
    );
    localStorage.setItem("tom-quest-frame-variant", JSON.stringify({ state: { variant: "B" }, version: 2 }));
    renderFrame();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.querySelector("[data-frame]")!.getAttribute("data-frame-variant")).toBe("B");
    expect(drawer("left").getAttribute("data-open")).toBe("true");
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
        seen: { a: { top: "sig", left: 4 } },
      }),
    ).toEqual({ open: { a: { left: true } }, size: { a: { left: 300 } }, lastSide: { a: "left" }, seen: { a: { top: "sig" } } });
    for (const junk of [undefined, null, 3, "x", [], { open: [] }]) {
      expect(storedFrameState(junk)).toEqual({ open: {}, size: {}, lastSide: {}, seen: {} });
    }
  });

  it("reads an unknown variant as A", () => {
    expect(storedVariant({ variant: "B" })).toBe("B");
    for (const junk of [undefined, null, {}, { variant: "C" }, { variant: "D" }, { variant: 2 }]) expect(storedVariant(junk)).toBe("A");
  });
});
