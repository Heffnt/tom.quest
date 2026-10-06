// The sessions page drawn from fixture rows in the shapes the record holds:
// the persistent group above the rest, a background agent opening in the
// center and closing back to the session, the login selector writing the
// session's login field, the collapsible columns, and the context row closed
// until pressed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const convex = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  mutations: [] as string[],
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useQuery: (ref: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      return convex.results[name(ref as never)];
    },
    useMutation: (ref: unknown) => async (args: unknown) => {
      convex.mutations.push(`${name(ref as never)}:${JSON.stringify(args)}`);
    },
  };
});

let search = new URLSearchParams();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => search,
}));
vi.mock("@/app/lib/auth", () => ({ useAuth: () => ({ isTom: true }) }));
vi.mock("@/app/components/tom-gate", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// The transcript component has its own tests (app/agents/components/agent.test.tsx);
// here it shows what the page handed it.
vi.mock("@/app/agents/components/agent", () => ({
  default: (props: {
    runId?: string;
    sessionId?: string;
    fullWidth?: boolean;
    controlsInComposer?: boolean;
    extraControls?: React.ReactNode;
    renderTop?: unknown;
  }) => (
    <div data-testid="transcript">
      <span>transcript {props.runId ?? props.sessionId}</span>
      {props.fullWidth && <span>full width</span>}
      {props.controlsInComposer && <span>controls in composer</span>}
      {props.renderTop !== undefined && <span>context row</span>}
      {props.extraControls}
    </div>
  ),
}));

import SessionsClient from "./sessions-client";
import ContextPanel from "./components/context-panel";
import { useSessionsLayout } from "./store";

const SESSION_ID = "k17abcdefghijklmnopqrstu";
const RUN_ID = "claude:box:0123456789abcdef";
const CHILD_RUN = "claude:box:0123456789abcdef/agent-fedcba9876543210";

function session(over: Record<string, unknown>) {
  return {
    _id: "k17zzzzzzzzzzzzzzzzzzzzz",
    _creationTime: 1,
    title: "a session",
    kind: "adhoc",
    repo: "none",
    status: "idle",
    statusChangedAt: 1_000,
    createdAt: 1_000,
    nextSeq: 0,
    model: "opus",
    ...over,
  };
}

beforeEach(() => {
  convex.mutations = [];
  convex.results = {
    "claudeSessions:sessionsPage": {
      persistent: [
        session({ _id: "k17pppppppppppppppppppp1", title: "dump", kind: "persistent", login: "gmail" }),
        session({ _id: "k17pppppppppppppppppppp2", title: "todo", kind: "persistent" }),
      ],
      others: [
        session({ _id: "k17ooooooooooooooooooo01", title: "older reply", statusChangedAt: 2_000 }),
        session({ _id: SESSION_ID, title: "newest reply", statusChangedAt: 9_000, runId: RUN_ID }),
      ],
    },
    "claudeSessions:getDaemonHealth": { lastSeenAt: Date.now(), daemonStartedAt: 0, version: "x", activeAccount: "wpi" },
    "claudeSessions:sessionByLink": session({ _id: SESSION_ID, title: "newest reply", runId: RUN_ID }),
    "agents:children": {
      items: [
        { runId: CHILD_RUN, kind: "subagent", status: "running", startedAt: 5_000, depth: 1, model: "claude-sonnet" },
      ],
      nextCursor: null,
    },
  };
  useSessionsLayout.setState({ leftOpen: true, rightOpen: true });
});

afterEach(() => {
  cleanup();
  search = new URLSearchParams();
  replace.mockClear();
});

describe("the sessions page", () => {
  it("draws the persistent sessions with their icons above every other session, newest activity first", () => {
    render(<SessionsClient />);
    const persistent = screen.getByRole("region", { name: "Persistent" });
    const other = screen.getByRole("region", { name: "Other" });
    expect(within(persistent).getByText("dump")).toBeTruthy();
    expect(persistent.querySelector('[data-icon="dump"]')).not.toBeNull();
    expect(persistent.querySelector('[data-icon="todo"]')).not.toBeNull();
    expect(other.querySelector("[data-icon]")).toBeNull();
    const titles = within(other).getAllByRole("button").map((b) => b.textContent ?? "");
    expect(titles[0]).toContain("newest reply");
    expect(titles[1]).toContain("older reply");
    // Persistent comes first in the column.
    expect(persistent.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The login label: the row's own, else the box's.
    expect(within(persistent).getByText("gmail")).toBeTruthy();
    expect(within(other).getAllByText("wpi").length).toBe(2);
  });

  it("opens a session with the context row, full-width rows and its controls in the composer", () => {
    search = new URLSearchParams(`session=${SESSION_ID}`);
    render(<SessionsClient />);
    const transcript = screen.getByTestId("transcript");
    expect(within(transcript).getByText(`transcript ${SESSION_ID}`)).toBeTruthy();
    expect(within(transcript).getByText("full width")).toBeTruthy();
    expect(within(transcript).getByText("controls in composer")).toBeTruthy();
    expect(within(transcript).getByText("context row")).toBeTruthy();
  });

  it("writes the session's login field from the login selector", () => {
    search = new URLSearchParams(`session=${SESSION_ID}`);
    render(<SessionsClient />);
    const select = screen.getByLabelText("session login") as HTMLSelectElement;
    expect(select.value).toBe("wpi");
    fireEvent.change(select, { target: { value: "gmail" } });
    expect(convex.mutations).toEqual([
      `claudeSessions:setSessionLogin:${JSON.stringify({ sessionId: SESSION_ID, login: "gmail" })}`,
    ]);
  });

  it("opens a background agent in the center and closes back to the session", () => {
    search = new URLSearchParams(`session=${SESSION_ID}`);
    const { rerender } = render(<SessionsClient />);
    const background = screen.getByRole("complementary", { name: "Background" });
    fireEvent.click(within(background).getByRole("button", { name: /subagent/ }));
    expect(replace).toHaveBeenLastCalledWith(
      `/sessions?session=${SESSION_ID}&agent=${encodeURIComponent(CHILD_RUN)}`,
      { scroll: false },
    );

    search = new URLSearchParams(`session=${SESSION_ID}&agent=${encodeURIComponent(CHILD_RUN)}`);
    rerender(<SessionsClient />);
    expect(screen.getByText(`transcript ${CHILD_RUN}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(replace).toHaveBeenLastCalledWith(`/sessions?session=${SESSION_ID}`, { scroll: false });
  });

  it("collapses and reopens both side columns", () => {
    render(<SessionsClient />);
    fireEvent.click(screen.getByRole("button", { name: "collapse Sessions" }));
    expect(screen.queryByRole("region", { name: "Persistent" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "collapse Background" }));
    expect(screen.queryByRole("complementary", { name: "Background" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "open Sessions" }));
    expect(screen.getByRole("region", { name: "Persistent" })).toBeTruthy();
    expect(screen.getAllByRole("separator").length).toBe(1);
  });

  it("draws an empty Persistent group when no row is persistent", () => {
    convex.results["claudeSessions:sessionsPage"] = { persistent: [], others: [] };
    render(<SessionsClient />);
    const persistent = screen.getByRole("region", { name: "Persistent" });
    expect(within(persistent).getByText("none")).toBeTruthy();
  });
});

describe("the context row", () => {
  it("is closed until pressed, then shows the run's context facts and its tool results in order", () => {
    convex.results["agents:contextRows"] = [
      {
        _id: "c1", _creationTime: 1, runId: RUN_ID, seq: 0, turn: 0, kind: "context",
        content: { model: "opus", tools: ["Bash"], skillsUsed: [], prompt: "the opening prompt" },
        createdAt: 1, provenance: {}, hasOverflow: false,
      },
    ];
    const run = {
      runId: RUN_ID,
      context: { tools: ["Bash", "Read"], hooks: ["SessionStart"], skillsOffered: [], skillsUsed: [], cwd: "/home/jarvis" },
    };
    const rows = [
      { _id: "r1", _creationTime: 1, runId: RUN_ID, seq: 1, turn: 1, kind: "tool-call", content: { toolUseId: "t1", toolName: "Bash", input: { command: "ls" } }, createdAt: 2, provenance: {} },
      { _id: "r2", _creationTime: 1, runId: RUN_ID, seq: 2, turn: 1, kind: "tool-result", content: { toolUseId: "t1", text: "first result" }, createdAt: 3, provenance: {} },
      { _id: "r3", _creationTime: 1, runId: RUN_ID, seq: 3, turn: 1, kind: "tool-result", content: { toolUseId: "t2", text: "second result" }, createdAt: 4, provenance: {} },
    ];
    const { container } = render(<ContextPanel run={run as never} rows={rows as never} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText("Context as the agent sees it")).toBeTruthy();
    expect(screen.getByText("1 context rows · 2 tool results")).toBeTruthy();
    details.open = true;
    expect(within(details).getByText("SessionStart")).toBeTruthy();
    expect(within(details).getByText("Bash, Read")).toBeTruthy();
    const text = details.textContent ?? "";
    expect(text.indexOf("first result")).toBeLessThan(text.indexOf("second result"));
  });
});

describe("a link to a session the record does not hold", () => {
  it("says so instead of throwing", () => {
    convex.results["claudeSessions:sessionByLink"] = null;
    search = new URLSearchParams("session=not-an-id");
    render(<SessionsClient />);
    expect(screen.getByText("this record does not hold that session")).toBeTruthy();
    expect(screen.queryByTestId("transcript")).toBeNull();
  });
});
