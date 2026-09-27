import fs from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EDGES_TOPMOST_FIRST, nextOpenState, topmostOpen } from "./rules";
import { useFrameStore } from "./frame-store";
import { prepareExplainer } from "./info";
import Frame from "./frame";

vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ user: null, role: "user", isTom: false }),
  getUsername: () => "",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/tts" }));
vi.mock("../debug-panel", () => ({ Diagnostics: () => null, useDiagnosticsStatus: () => ({ convex: "connected", events: [] }) }));

const desktop = { width: 1440, railSide: 28, leftWidth: 360, rightWidth: 440 };

describe("frame layout rules", () => {
  it("stacks drawers in the order globals.css gives their z layers", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../globals.css"), "utf8");
    const z = (edge: string) => Number(new RegExp(`--z-drawer-${edge}:\\s*(\\d+)`).exec(css)?.[1]);
    const byLayer = [...EDGES_TOPMOST_FIRST].sort((a, b) => z(b) - z(a));
    expect(byLayer).toEqual(["right", "left", "bottom", "top"]);
    expect(EDGES_TOPMOST_FIRST).toEqual(byLayer);
    const rail = Number(/--z-rail:\s*(\d+)/.exec(css)?.[1]);
    expect(EDGES_TOPMOST_FIRST.every((edge) => z(edge) < rail)).toBe(true);
  });

  it("closes the topmost open drawer first, by edge and not by opening order", () => {
    expect(topmostOpen({ top: true, right: true, bottom: true })).toBe("right");
    expect(topmostOpen({ top: true, bottom: true })).toBe("bottom");
    expect(topmostOpen({})).toBeNull();
  });

  it("keeps both sides open on a wide screen and one side under 1024px", () => {
    expect(nextOpenState({ left: true }, "right", true, desktop)).toEqual({ left: true, right: true });
    expect(nextOpenState({ left: true }, "right", true, { ...desktop, width: 1000 })).toEqual({ left: false, right: true });
  });

  it("closes the other side when both would leave the center under 160px", () => {
    // 1100 - 56 = 1044 inner; 400 + 500 = 900 > 1044 - 160 = 884.
    expect(nextOpenState({ left: true }, "right", true, { ...desktop, width: 1100, leftWidth: 400, rightWidth: 500 })).toEqual({
      left: false,
      right: true,
    });
  });

  it("opens one sheet at a time on a phone", () => {
    expect(nextOpenState({ left: true, top: true }, "bottom", true, { ...desktop, width: 390 })).toEqual({ bottom: true });
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
  const spec = (title: string) => ({ title, body: <p>{title} body</p> });
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

describe("<Frame>", () => {
  beforeEach(() => {
    localStorage.clear();
    useFrameStore.setState({ open: {}, seen: {} });
  });

  it("toggles drawers with W A S D and closes them with Escape, topmost first", () => {
    renderFrame();
    act(() => {
      fireEvent.keyDown(window, { key: "s" });
      fireEvent.keyDown(window, { key: "d" });
      fireEvent.keyDown(window, { key: "w" });
    });
    expect(drawer("bottom").getAttribute("data-open")).toBe("true");
    expect(drawer("right").getAttribute("data-open")).toBe("true");
    expect(drawer("top").getAttribute("data-open")).toBe("true");
    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    expect(drawer("right").getAttribute("data-open")).toBe("false");
    expect(drawer("bottom").getAttribute("data-open")).toBe("true");
    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    expect(drawer("bottom").getAttribute("data-open")).toBe("false");
    expect(drawer("top").getAttribute("data-open")).toBe("true");
  });

  it("ignores the keys while a text field has focus", () => {
    renderFrame();
    const input = screen.getByLabelText("Navigate to a page");
    act(() => fireEvent.keyDown(input, { key: "s" }));
    expect(drawer("bottom").getAttribute("data-open")).toBe("false");
  });

  it("toggles a drawer from its rail and leaves the center element untouched", () => {
    renderFrame();
    const center = document.querySelector("[data-frame-center]")!;
    const before = center.outerHTML;
    act(() => fireEvent.click(document.querySelector("button[data-frame-rail=\"left\"]")!));
    expect(drawer("left").getAttribute("data-open")).toBe("true");
    expect(document.querySelector("[data-frame-center]")).toBe(center);
    expect(center.outerHTML).toBe(before);
  });

  it("switches the closed-drawer variant with keys 1 to 4, not while typing, and stores it", () => {
    renderFrame();
    const root = document.querySelector("[data-frame]")!;
    expect(root.getAttribute("data-frame-variant")).toBe("A");
    act(() => fireEvent.keyDown(window, { key: "3" }));
    expect(root.getAttribute("data-frame-variant")).toBe("C");
    act(() => fireEvent.keyDown(screen.getByLabelText("Navigate to a page"), { key: "2" }));
    expect(root.getAttribute("data-frame-variant")).toBe("C");
    act(() => fireEvent.click(screen.getByRole("radio", { name: "D" })));
    expect(root.getAttribute("data-frame-variant")).toBe("D");
    expect(JSON.parse(localStorage.getItem("tom-quest-frame-variant") ?? "{}").state.variant).toBe("D");
    act(() => fireEvent.keyDown(window, { key: "1" }));
  });

  it("persists the open drawers per page", () => {
    renderFrame();
    act(() => fireEvent.keyDown(window, { key: "a" }));
    expect(useFrameStore.getState().open.test).toEqual({ left: true });
    expect(JSON.parse(localStorage.getItem("tom-quest-frame") ?? "{}").state.open.test).toEqual({ left: true });
  });
});
