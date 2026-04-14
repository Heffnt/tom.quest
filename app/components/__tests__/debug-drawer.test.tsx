import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debug } from "@/app/lib/debug";

const useAuth = vi.fn(() => ({ isTom: true }));

vi.mock("@/app/lib/auth", () => ({
  useAuth,
}));

describe("DebugDrawer", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    debug.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.restoreAllMocks();
    debug.clear();
  });

  async function renderDrawer(overrides: {
    openEdge?: "left" | "right" | "bottom" | null;
    sizeByEdge?: { left: number; right: number; bottom: number };
    onOpen?: (edge: "left" | "right" | "bottom") => void;
    onClose?: () => void;
    onResize?: (edge: "left" | "right" | "bottom", size: number) => void;
    onResizeStart?: () => void;
    onResizeEnd?: () => void;
  } = {}) {
    const { default: DebugDrawer } = await import("@/app/components/debug-drawer");
    const props = {
      openEdge: "right" as const,
      sizeByEdge: { left: 320, right: 360, bottom: 280 },
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onResize: vi.fn(),
      onResizeStart: vi.fn(),
      onResizeEnd: vi.fn(),
      ...overrides,
    };

    root = createRoot(container);
    await act(async () => {
      root.render(<DebugDrawer {...props} />);
    });
    return props;
  }

  it("renders debug lines and does not close on outside click", async () => {
    debug.scoped("test").log("hello");
    const props = await renderDrawer();

    expect(container.textContent).toContain("hello");

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("copies the snapshot text from the panel", async () => {
    debug.scoped("copy").log("ready");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await renderDrawer({ openEdge: "left" });

    const copyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Copy",
    );
    expect(copyButton).toBeTruthy();

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const copiedSnapshot = writeText.mock.calls[0]?.[0];
    expect(typeof copiedSnapshot).toBe("string");
    expect(copiedSnapshot).toContain("tom.quest debug --");
    expect(copiedSnapshot).toContain("route: /");
    expect(copiedSnapshot).toContain("[copy] ready");
    expect(container.textContent).toContain("Copied");
  });
});
