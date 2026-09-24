// The EVERYTHING tab as a composition of the toolbox (vqc/pages.md): the
// counts it states, the one todo it puts in front of Tom and how a pick
// replaces it, and the calls its verdicts, status writes and time note fire.
// The derivations themselves are tested in app/tts/lib.test.ts; this file
// holds the page to wiring them to the right component and the right call.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { api } from "@/convex/_generated/api";
import EverythingTab from "./everything-tab";

const convex = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useQuery: (ref: unknown, args: unknown) =>
      args === "skip" ? undefined : convex.data[name(ref as never)],
    useMutation: (ref: unknown) => async (args: unknown) => {
      convex.calls.push({ name: name(ref as never), args });
      return name(ref as never) === "claudeSessions:createSession" ? "s-new" : null;
    },
  };
});

// app/lib/auth pulls in Sentry, which does not load under jsdom.
vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ isTom: true, canReadSurface: () => true }),
}));

const DAY = 86_400_000;
const NOW = Date.now();

const todo = (over: Record<string, unknown>) => ({
  _id: "t-active",
  _creationTime: 10,
  statement: "renew the visa",
  status: "active",
  readiness: "prepared",
  actor: "tom",
  source: "email",
  needs: [],
  createdAt: NOW - 3 * DAY,
  updatedAt: NOW - 3 * DAY,
  ...over,
});

const MIRROR = {
  _id: "m1",
  _creationTime: 1,
  repo: "tom.quest",
  externalId: "todo-14",
  statement: "fence the session repo list",
  tier: "now",
  status: "open",
  url: "https://example.invalid/todo-14",
  syncedAt: NOW,
};

const BRIEF = {
  _id: "b1",
  _creationTime: 1,
  repo: "tom.quest",
  externalId: "todo-14",
  brief: "the code brief",
  recommendation: "approve",
  execClass: "box",
  preparedAt: NOW - DAY,
};

const TODOS = [
  todo({ _id: "t-old", statement: "call the dentist", _creationTime: 1, source: "manual" }),
  todo({ _id: "t-late", statement: "pay the rent", _creationTime: 5, dueAt: NOW - DAY, brief: "the rent brief", entryAction: "open the bank" }),
  todo({ _id: "t-blocked", statement: "book the flight", needs: ["t-old"] }),
  todo({ _id: "t-raw", statement: "a raw capture", readiness: "unprepared", dueAt: NOW + 2 * DAY }),
  todo({ _id: "t-agent", statement: "let an agent do it", actor: "agent" }),
  todo({ _id: "t-done", statement: "already finished", status: "done", doneAt: NOW - DAY }),
];

function load(todos: unknown[] = TODOS, mirror: unknown[] = [], briefs: unknown[] = []) {
  convex.data = {
    [getFunctionName(api.tts.listTodos)]: todos,
    [getFunctionName(api.tts.listMirror)]: mirror,
    [getFunctionName(api.ttsCode.listCodeBriefs)]: briefs,
    [getFunctionName(api.ttsRulings.listRulings)]: [],
    [getFunctionName(api.tts.listTimeNotes)]: [],
    [getFunctionName(api.tts.listRecentEvents)]: [
      { kind: "captured", at: NOW - DAY },
      { kind: "captured", at: NOW - 2 * DAY },
      { kind: "merge", at: NOW - DAY },
    ],
    [getFunctionName(api.ttsRunners.listRunners)]: [],
    [getFunctionName(api.claudeSessions.listSessions)]: [
      { title: "the newest agent", status: "idle", _creationTime: NOW - 3_600_000 },
    ],
  };
}

function show(link: { item: string; intent: "done" | "archive" | "engage" | null } | null = null, onLinkCleared = () => {}) {
  render(<EverythingTab link={link} onLinkCleared={onLinkCleared} />);
}

const fired = (name: string) => convex.calls.filter((c) => c.name === name).map((c) => c.args);
const panel = () => document.querySelector("article")!;

beforeEach(() => {
  convex.calls.length = 0;
  vi.stubGlobal("open", () => null);
});
afterEach(() => cleanup());

describe("the counts on the page", () => {
  it("states the whole in one sentence", () => {
    load();
    show();
    const head = document.querySelector("header")!.textContent;
    expect(head).toContain(
      "5 active todos: 2 waiting on you, 1 waiting on another todo, 1 not yet prepared; 2 with a date, 1 of them overdue.",
    );
  });

  it("draws the four figures, the dated table and the done fold", () => {
    load();
    show();
    const figures = [...document.querySelectorAll(".tb-figure")].map((f) => f.textContent);
    expect(figures).toEqual(["1overdue", "2with a date", "1blocking others", "1done in the last 30 days", "0runners"]);
    const table = screen.getByRole("heading", { name: "with a date" }).parentElement!;
    expect(table.textContent).toContain("pay the rent");
    expect(table.textContent).toContain("overdue");
    expect(table.textContent).toContain("a raw capture");
    const folds = [...document.querySelectorAll("summary")].map((f) => f.textContent);
    expect(folds).toEqual(["done 1", "runners 0"]);
  });

  it("states the week's agent work and the idle agents", () => {
    load();
    show();
    const prose = screen.getByRole("heading", { name: "agents this week" }).parentElement!.textContent;
    expect(prose).toContain("2 todos captured, 0 prepared, 1 merges");
    expect(prose).toContain("1 agents are idle; the newest, the newest agent, started 1 h ago.");
  });
});

describe("the one todo in front of Tom", () => {
  it("is the overdue todo waiting on him, whole", () => {
    load();
    show();
    const item = panel();
    expect(within(item).getByRole("heading", { name: "next" })).toBeTruthy();
    expect(item.textContent).toContain("pay the rent");
    expect(item.textContent).toContain("the rent brief");
    expect(item.textContent).toContain("open the bank");
    expect(item.textContent).toContain("From email.");
  });

  it("is replaced by a member picked in the drawer, and the pick is recorded as engaged", () => {
    load();
    show();
    const drawer = screen.getByRole("region", { name: "waiting on you" });
    fireEvent.click(within(drawer).getByText("call the dentist"));
    expect(within(panel()).getByRole("heading", { name: "picked" })).toBeTruthy();
    expect(panel().textContent).toContain("call the dentist");
    expect(fired("tts:recordEvent")).toEqual([
      { kind: "engaged", todoId: "t-old", data: { via: "everything" } },
    ]);
  });

  it("follows the cell picked in the figure", () => {
    load();
    show();
    fireEvent.click(document.querySelector('[aria-label="manual 1"]')!);
    expect(screen.getByRole("region", { name: "manual, waiting on you" })).toBeTruthy();
  });

  it("lands a linked todo in the panel with the action its link proposed", () => {
    load();
    show({ item: "t-raw", intent: "done" });
    expect(panel().textContent).toContain("a raw capture");
    expect(within(panel()).getByRole("button", { name: "done" }).className).toContain("is-recommended");
    expect(fired("tts:recordEvent")).toEqual([
      { kind: "engaged", todoId: "t-raw", data: { via: "everything-link", intent: "done" } },
    ]);
  });

  it("is the code todo waiting on him when no todo does", () => {
    load([], [MIRROR], [BRIEF]);
    show();
    expect(panel().textContent).toContain("fence the session repo list");
    expect(panel().textContent).toContain("the code brief");
  });
});

describe("the calls the panel fires", () => {
  it("approve records the ruling on the todo", async () => {
    load();
    show();
    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "approve" }));
    });
    expect(fired("ttsRulings:recordRuling")).toEqual([
      { todoId: "t-late", verdict: "approve", sentence: undefined },
    ]);
  });

  it("revise asks for its sentence and records it", async () => {
    load();
    show();
    fireEvent.click(within(panel()).getByRole("button", { name: "revise" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "ask the landlord first" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "revise" }));
    });
    expect(fired("ttsRulings:recordRuling")).toEqual([
      { todoId: "t-late", verdict: "revise", sentence: "ask the landlord first" },
    ]);
  });

  it("session records the ruling, then opens the session in the tab reserved by the press", async () => {
    const tab = { closed: false, location: { href: "" }, close: () => {} };
    vi.stubGlobal("open", () => tab);
    load();
    show();
    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "session" }));
    });
    expect(convex.calls.map((c) => c.name)).toEqual(["ttsRulings:recordRuling", "claudeSessions:createSession"]);
    expect(fired("claudeSessions:createSession")[0]).toMatchObject({ todoId: "t-late", kind: "gate" });
    expect(tab.location.href).toBe("/runs?session=s-new");
  });

  it("done writes the status with its note, and a todo not ready to rule offers done and archive", async () => {
    load();
    show({ item: "t-raw", intent: null });
    const labels = within(panel())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-label") !== "what this does")
      .map((b) => b.textContent);
    expect(labels).toEqual(["done", "archive", "note"]);
    fireEvent.click(within(panel()).getByRole("button", { name: "done" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "sent it" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "done" }));
    });
    expect(fired("tts:setStatus")).toEqual([{ id: "t-raw", status: "done", note: "sent it" }]);
  });

  it("a code todo's verdict records the ruling on the repo and its id", async () => {
    load([], [MIRROR], [BRIEF]);
    show();
    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "approve" }));
    });
    expect(fired("ttsRulings:recordRuling")).toEqual([
      { repo: "tom.quest", externalId: "todo-14", verdict: "approve", sentence: undefined },
    ]);
  });

  it("the time note files the sentence against the todo", async () => {
    load();
    show();
    fireEvent.change(within(panel()).getByRole("textbox", { name: "note" }), {
      target: { value: " before friday " },
    });
    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "note" }));
    });
    expect(fired("tts:createTimeNote")).toEqual([{ text: "before friday", todoId: "t-late" }]);
  });
});
