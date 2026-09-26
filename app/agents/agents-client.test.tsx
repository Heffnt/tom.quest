// The deep link is followed whenever the query string changes. The window
// view's links (/agents?agent=...) move within this same page, so the client
// stays mounted while its URL changes; a read on mount alone left the URL
// naming an agent and the page showing the window view.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let search = new URLSearchParams();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => search,
}));
vi.mock("convex/react", () => ({ useQuery: () => undefined }));
vi.mock("@/app/lib/auth", () => ({ useAuth: () => ({ isTom: true }) }));
vi.mock("@/app/components/tom-gate", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./components/agent-list", () => ({ default: () => <p>the agents list</p> }));
vi.mock("./window/window-view", () => ({ default: () => <p>the window view</p> }));
vi.mock("./components/agent", () => ({
  default: ({ runId, sessionId, onBack }: { runId?: string; sessionId?: string; onBack: () => void }) => (
    <button type="button" onClick={onBack}>agent {runId ?? sessionId}</button>
  ),
}));

import AgentsClient from "./agents-client";

afterEach(() => {
  cleanup();
  search = new URLSearchParams();
  replace.mockClear();
});

describe("AgentsClient's deep link", () => {
  it("opens the agent a link names after the page has mounted on the window view", () => {
    search = new URLSearchParams("view=window");
    const { rerender } = render(<AgentsClient />);
    expect(screen.getByText("the window view")).toBeTruthy();

    search = new URLSearchParams(`agent=${encodeURIComponent("claude:box:0123456789abcdef")}`);
    rerender(<AgentsClient />);
    expect(screen.getByText("agent claude:box:0123456789abcdef")).toBeTruthy();
    expect(screen.queryByText("the window view")).toBeNull();
  });

  it("goes back to the list when the query string stops naming an agent", () => {
    search = new URLSearchParams("session=abcdefghijklmnopqrstuvwx");
    const { rerender } = render(<AgentsClient />);
    expect(screen.getByText("agent abcdefghijklmnopqrstuvwx")).toBeTruthy();

    search = new URLSearchParams();
    rerender(<AgentsClient />);
    expect(screen.getByText("the agents list")).toBeTruthy();
  });

  it("ignores an agent id that is not id-shaped", () => {
    search = new URLSearchParams("agent=nope");
    render(<AgentsClient />);
    expect(screen.getByText("the agents list")).toBeTruthy();
  });

  // witness: the window view's agent links left out view=window, so Back
  // from an agent opened there went to the live list, not the window.
  it("opens an agent from the window view and goes back to the window", () => {
    search = new URLSearchParams(`view=window&agent=${encodeURIComponent("claude:box:0123456789abcdef")}`);
    render(<AgentsClient />);
    fireEvent.click(screen.getByText("agent claude:box:0123456789abcdef"));
    expect(replace).toHaveBeenCalledWith("/agents?view=window", { scroll: false });
  });
});
