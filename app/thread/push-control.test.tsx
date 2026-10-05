// The header's push control.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

let key: string | null | undefined = "key";
vi.mock("convex/react", () => ({ useQuery: () => key, useMutation: () => async () => {} }));
vi.mock("@/convex/_generated/api", () => ({ api: { push: { vapidPublicKey: "vapidPublicKey", saveSubscription: "saveSubscription" } } }));

import PushControl, { base64UrlToBytes } from "./push-control";

function browser(subscription: { endpoint: string } | null | Promise<{ endpoint: string } | null>) {
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", { permission: "default", requestPermission: async () => "granted" });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) },
  });
}

afterEach(() => {
  key = "key";
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("base64UrlToBytes", () => {
  it("decodes base64url with - and _ and no padding to the expected bytes", () => {
    // base64url of the five bytes 0xfe, 0xef, 0xa9, 0xf7, 0xfa.
    expect(Array.from(base64UrlToBytes("_u-p9_o"))).toEqual([0xfe, 0xef, 0xa9, 0xf7, 0xfa]);
  });
});

describe("PushControl", () => {
  it("offers to subscribe a browser with no subscription", async () => {
    browser(null);
    render(<PushControl />);
    const button = (await screen.findByText("Subscribe this device")).closest("button")!;
    expect(button.disabled).toBe(false);
  });

  it("is disabled while the VAPID key is loading or unset", async () => {
    browser(null);
    key = undefined;
    const { rerender } = render(<PushControl />);
    expect(((await screen.findByRole("button")) as HTMLButtonElement).disabled).toBe(true);
    key = null;
    rerender(<PushControl />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    key = "key";
    rerender(<PushControl />);
    expect((await screen.findByText("Subscribe this device")).closest("button")!.disabled).toBe(false);
  });

  it("shows nothing decisive, disabled, until the lookup answers after the key, then Subscribed", async () => {
    let answer: (one: { endpoint: string }) => void = () => {};
    browser(new Promise((resolve) => { answer = resolve; }));
    render(<PushControl />);
    const button = await screen.findByRole("button", { name: "…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer({ endpoint: "https://push.example/1" }));
    expect((screen.getByRole("button", { name: "Subscribed" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says Subscribed, disabled, for a browser that has one", async () => {
    browser({ endpoint: "https://push.example/1" });
    render(<PushControl />);
    const button = await screen.findByRole("button", { name: "Subscribed" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("is hidden without PushManager", () => {
    const { container } = render(<PushControl />);
    expect(container.innerHTML).toBe("");
  });
});
