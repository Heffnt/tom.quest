// Regression guard for the one thing this screen's layout promises: NOTHING
// of the app's own renders above the transcript. The session screen used to
// carry a header band (back arrow, title, chips, a row of facts, an outcome
// line) between the top of the page and the first message; it was removed so
// the chat window reaches the top of the screen.
//
// The band is easy to put back by accident — a "just one line" status strip
// above the transcript is the natural place to add anything. These tests fail
// if it comes back, and they also fail if the removal strands the reader:
// the way out and the session's identity have to survive somewhere.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SessionView from "./session-view";

// jsdom ships no matchMedia; the view reads it once to decide whether to mount
// the agent panel. false = the phone case, which is the one this file is about.
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const fixture = vi.hoisted(() => ({
  session: {
    _id: "s1",
    _creationTime: 0,
    title: "remove the top chrome",
    repo: "tom.quest",
    status: "running",
    statusChangedAt: Date.now(),
    mode: "interactive",
    cwd: "/home/tom/work/tom.quest",
  },
}));

vi.mock("@/convex/_generated/api", () => ({
  api: {
    claudeSessions: {
      getSession: "getSession",
      getPendingPermissions: "getPendingPermissions",
      renameSession: "renameSession",
      sendMessage: "sendMessage",
      sendControl: "sendControl",
      forceClose: "forceClose",
      reopenSession: "reopenSession",
    },
  },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => (ref === "getSession" ? fixture.session : []),
  useMutation: () => vi.fn(),
}));

// The transcript owns a live paginated subscription and the agent panel owns
// another; neither is what these tests are about. Stubs keep the assertions
// about ORDER, not about data.
vi.mock("./transcript", () => ({
  default: () => <div data-testid="transcript">messages</div>,
}));
vi.mock("./agent-panel", () => ({
  default: () => <div data-testid="agent-panel" />,
}));

const mount = (notice: React.ReactNode = null) =>
  render(
    <SessionView
      sessionId={"s1" as never}
      now={Date.now()}
      daemonStale={false}
      daemonLastSeenAt={undefined}
      notice={notice}
      onBack={() => {}}
    />,
  );

const sessionRoot = (container: HTMLElement) => container.firstElementChild!;

describe("session view — the transcript owns the top edge", () => {
  it("renders the transcript as the first thing in the column", () => {
    const { container } = mount();
    const first = sessionRoot(container).firstElementChild!;
    expect(first.contains(screen.getByTestId("transcript"))).toBe(true);
  });

  it("puts every remaining control after the transcript in document order", () => {
    mount();
    const transcript = screen.getByTestId("transcript");
    for (const el of [
      screen.getByLabelText("Back to sessions"),
      screen.getByText("running"),
      screen.getByRole("button", { name: "details" }),
    ]) {
      // Node.DOCUMENT_POSITION_FOLLOWING === 4: `el` comes after the transcript.
      expect(transcript.compareDocumentPosition(el) & 4).toBe(4);
    }
  });

  it("keeps a way back out and the session's identity on screen", () => {
    mount();
    expect(screen.getByLabelText("Back to sessions")).toBeTruthy();
    expect(
      screen.getByLabelText("Rename session").textContent,
    ).toBe("remove the top chrome");
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("moves the facts the header used to show into the details dialog", () => {
    mount();
    expect(screen.queryByText("/home/tom/work/tom.quest")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "details" }));
    expect(screen.getByText("/home/tom/work/tom.quest")).toBeTruthy();
    expect(screen.getByText("tom.quest")).toBeTruthy();
  });

  it("renders the worker notice below the transcript, not above it", () => {
    mount(<div data-testid="notice">worker has not reported yet</div>);
    const transcript = screen.getByTestId("transcript");
    const notice = screen.getByTestId("notice");
    expect(transcript.compareDocumentPosition(notice) & 4).toBe(4);
  });
});
