// The EVERYTHING tab's filters, after the two the lifeos update removed.
//
// Both removals are invisible to a type checker and both could hide a row,
// which is the one thing this tab may never do:
//   - the ready-for-tom toggle is gone, so no row is filtered by readiness;
//     what a reader wanted from it — why a row is not ready — is the waiting
//     line every row prints (ttsShared.waitingReason).
//   - "waiting" is gone as a status chip, so a row still carrying the stored
//     status has to read as ACTIVE here or it would match no chip at all and
//     vanish from the page.
// The four filters that stay (search, status, kind, category) and the sort are
// pinned here too, because removing two predicates from a chain of five is
// exactly where the remaining three get dropped by accident.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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
    },
  };
});

// app/lib/auth pulls in Sentry, which does not load under jsdom.
vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ isTom: true, canReadSurface: () => true }),
}));

const NOW = 1_756_000_000_000;

const todo = (over: Record<string, unknown>) => ({
  _id: "t-active",
  _creationTime: 1,
  statement: "renew the visa",
  status: "active",
  readiness: "prepared",
  actor: "tom",
  category: "admin",
  source: "tom",
  needs: [],
  createdAt: NOW,
  updatedAt: NOW,
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

function load(todos: unknown[], mirror: unknown[] = []) {
  convex.data = {
    [getFunctionName(api.tts.listTodos)]: todos,
    [getFunctionName(api.tts.listMirror)]: mirror,
    [getFunctionName(api.ttsCode.listCodeBriefs)]: [],
    [getFunctionName(api.ttsRulings.listRulings)]: [],
    [getFunctionName(api.tts.listTimeNotes)]: [],
  };
}

function show(link: { item: string; intent: null } | null = null) {
  render(<EverythingTab link={link} onLinkCleared={() => {}} />);
}

/** The toolbar chip with this label, whatever count it carries. */
function chip(label: string): HTMLElement | undefined {
  return screen
    .queryAllByRole("button")
    .find((b) => (b.textContent ?? "").startsWith(label));
}

const body = () => document.body.textContent ?? "";

beforeEach(() => {
  convex.calls.length = 0;
  cleanup();
});

describe("the filters the lifeos update removed", () => {
  it("offers no readiness filter", () => {
    load([todo({})]);
    show();
    expect(chip("ready-for-tom")).toBeUndefined();
    // …and the unprepared row is listed, not filtered out.
    cleanup();
    load([todo({ _id: "t-raw", readiness: "unprepared", statement: "a raw capture" })]);
    show();
    expect(body()).toContain("a raw capture");
  });

  it("offers no waiting status chip", () => {
    load([todo({})]);
    show();
    expect(chip("waiting")).toBeUndefined();
    for (const s of ["active", "done", "archived"]) {
      expect(chip(s), `the ${s} chip`).toBeTruthy();
    }
  });

  // witness: read a stored "waiting" row as its own status in rowStatuses —
  // it matches no chip, and the row disappears from the page entirely.
  it("lists a row still carrying the stored waiting status, under active", () => {
    load([
      todo({
        _id: "t-asleep",
        statement: "chase the landlord",
        status: "waiting",
        wakeCondition: "the landlord writes back",
      }),
    ]);
    show();
    expect(body()).toContain("chase the landlord");
    // The active chip counts it, because that is what it now is.
    expect(chip("active")?.textContent).toContain("1");
  });

  it("prints the computed waiting reason on the row", () => {
    load([
      todo({
        _id: "t-blocked",
        statement: "book the flight",
        needs: ["t-open"],
      }),
      todo({ _id: "t-open", statement: "pick the dates" }),
    ]);
    show();
    expect(body()).toContain("waiting on: pick the dates");
    // An agent task with nothing in its way waits on nothing and says nothing.
    cleanup();
    load([todo({ _id: "t-free", statement: "let an agent run", actor: "agent" })]);
    show();
    expect(body()).not.toContain("waiting");
  });
});

describe("the filters that stay", () => {
  it("filters by search text", () => {
    load([
      todo({ _id: "a", statement: "renew the visa" }),
      todo({ _id: "b", statement: "book the flight" }),
    ]);
    show();
    fireEvent.change(screen.getByPlaceholderText("search"), {
      target: { value: "visa" },
    });
    expect(body()).toContain("renew the visa");
    expect(body()).not.toContain("book the flight");
  });

  it("filters by status — done is hidden until its chip is on", () => {
    load([
      todo({ _id: "a", statement: "renew the visa" }),
      todo({ _id: "b", statement: "already finished", status: "done", doneAt: NOW }),
    ]);
    show();
    expect(body()).not.toContain("already finished");
    fireEvent.click(chip("done")!);
    expect(body()).toContain("already finished");
  });

  it("filters by kind", () => {
    load([todo({ statement: "renew the visa" })], [MIRROR]);
    show();
    expect(body()).toContain("fence the session repo list");
    fireEvent.click(chip("code")!);
    expect(body()).not.toContain("fence the session repo list");
    expect(body()).toContain("renew the visa");
  });

  it("filters by category", () => {
    load([
      todo({ _id: "a", statement: "renew the visa", category: "admin" }),
      todo({ _id: "b", statement: "climb on friday", category: "climbing" }),
    ]);
    show();
    fireEvent.change(screen.getByDisplayValue("category: all"), {
      target: { value: "climbing" },
    });
    expect(body()).toContain("climb on friday");
    expect(body()).not.toContain("renew the visa");
  });

  it("sorts by the chosen key", () => {
    // The two keys disagree on purpose: `a` is due later and was captured
    // later, so dueAt puts it second and createdAt — newest first — puts it
    // first. An assertion on the count alone would pass with the control
    // wired to nothing.
    load([
      todo({
        _id: "a",
        statement: "later",
        dueAt: NOW + 2 * 86_400_000,
        createdAt: NOW,
      }),
      todo({
        _id: "b",
        statement: "sooner",
        dueAt: NOW + 86_400_000,
        createdAt: NOW - 86_400_000,
      }),
    ]);
    show();
    const statements = () =>
      [...document.querySelectorAll("[id^='todo-']")].map((el) => el.id);
    expect(statements()).toEqual(["todo-b", "todo-a"]);
    fireEvent.change(screen.getByDisplayValue("sort: dueAt"), {
      target: { value: "createdAt" },
    });
    expect(statements()).toEqual(["todo-a", "todo-b"]);
  });

  it("shows a row a link names even when its status chip is off", () => {
    load([todo({ _id: "t-done", statement: "already finished", status: "done" })]);
    show({ item: "t-done", intent: null });
    expect(body()).toContain("already finished");
  });
});
