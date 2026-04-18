import type { AnchorHTMLAttributes, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ user: null, isTom: false }),
  getUsername: () => "",
}));

vi.mock("@/app/components/tom-logo", () => ({
  default: () => <div data-testid="tom-logo" />,
}));

vi.mock("@/app/components/login-modal", () => ({
  default: () => null,
}));

vi.mock("@/app/components/profile-modal", () => ({
  default: () => null,
}));

describe("HomeClient", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    push.mockReset();
    vi.restoreAllMocks();
  });

  async function renderHome(): Promise<void> {
    const { default: HomeClient } = await import("@/app/home-client");
    const nextRoot = createRoot(container);
    root = nextRoot;
    await act(async () => {
      nextRoot.render(<HomeClient />);
    });
  }

  it("leaves the destination input unfocused until the user opens it", async () => {
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, "focus");

    await renderHome();

    expect(focusSpy).not.toHaveBeenCalled();

    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="pick a destination"]',
    );
    const terminal = input?.parentElement?.parentElement;
    expect(input).toBeTruthy();
    expect(terminal).toBeTruthy();

    await act(async () => {
      terminal?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(focusSpy).toHaveBeenCalledTimes(1);
  });
});
