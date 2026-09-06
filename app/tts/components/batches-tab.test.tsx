// The batches tab's two rulings that are not the batch's own: the detail
// dialog, opened on a task or a goal inside a card.
//
// Both regressions here are invisible to a type checker. A dialog holding the
// item it was opened WITH keeps offering the four verdicts on a subject that
// has since been archived — every one of them a ruling on a resting row. And a
// goal that lives in a repository is a code subject: ruled as a life todo, the
// verdict is filed against a dtsTodos row the executor on the Jarvis Box never
// reads.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { api } from "@/convex/_generated/api";
import BatchesTab from "./batches-tab";

// The Convex subscriptions, as a plain table keyed by "module:function". A
// rerender re-reads it, which is how a ruling's effect on the data is played
// back here: change the table, rerender, look at the dialog.
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

// app/lib/auth pulls in Sentry, which does not load under jsdom. Nothing here
// depends on the answer beyond "this viewer may read TTS": every mutation on
// this surface is refused by Convex, not by the client.
vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ isTom: true, canReadSurface: () => true }),
}));

const BATCH = {
  _id: "batch-1",
  _creationTime: 0,
  statement: "Land the lifeos update",
  status: "active",
  updatedAt: 1,
};

const TASK = {
  _id: "t1",
  _creationTime: 0,
  batchId: "batch-1",
  kind: "task",
  statement: "Ratify the amendment",
  actor: "tom",
  needs: [],
  status: "active",
  readiness: "ready-for-tom",
  updatedAt: 1,
};

const CODE_GOAL = {
  _id: "g1",
  _creationTime: 0,
  batchId: "batch-1",
  kind: "goal",
  statement: "The session repo list is fenced",
  status: "active",
  readiness: "ready-for-tom",
  codeRepo: "tom.quest",
  codeExternalId: "todo-14",
  updatedAt: 1,
};

function load(todos: unknown[]) {
  convex.data = {
    [getFunctionName(api.tts.listTodos)]: todos,
    [getFunctionName(api.tts.listBatches)]: [BATCH],
    [getFunctionName(api.tts.listMirror)]: [],
    [getFunctionName(api.ttsCode.listCodeBriefs)]: [],
    [getFunctionName(api.ttsRulings.listRulings)]: [],
    [getFunctionName(api.tts.listTimeNotes)]: [],
  };
}

/** The open detail dialog — the fixed overlay the close button sits in. The
 * expanded card behind it carries the BATCH's own verdict row, so every query
 * about the dialog's verdicts has to be scoped to this. */
function dialog(): HTMLElement {
  const close = screen.getByRole("button", { name: "close" });
  return close.closest("div.fixed") as HTMLElement;
}

/** The verdict chips the dialog is offering. */
function verdicts(): string[] {
  return within(dialog())
    .queryAllByRole("button")
    .map((b) => b.textContent ?? "")
    .filter((t) => ["approve", "revise", "session", "archive"].includes(t));
}

function ruled(): unknown[] {
  return convex.calls
    .filter((c) => c.name === getFunctionName(api.ttsRulings.recordRuling))
    .map((c) => c.args);
}

/** Expand the batch card and open the detail dialog on one of its items. */
function openDetail(statement: string) {
  fireEvent.click(screen.getByText(BATCH.statement));
  fireEvent.click(screen.getAllByText(statement)[0]);
}

// A stored "waiting" row (still readable during the widen) is a sleep. The tab
// once gave a wordless one a wakeAt of MAX_SAFE_INTEGER so isReady would hold
// it back, and the card then printed "waiting until" the year 275760. The
// task keeps status "waiting" instead; ttsShared.waitingReason reads it by its
// words, and isReady already excludes it.
describe("a stored waiting task on the card", () => {
  beforeEach(() => {
    convex.calls.length = 0;
    vi.stubGlobal("open", () => null);
  });

  it("reads as a sleep by its words, never as a made-up instant", () => {
    load([{ ...TASK, status: "waiting", wakeCondition: "the landlord writes back" }]);
    render(<BatchesTab />);
    fireEvent.click(screen.getByText(BATCH.statement));
    const text = document.body.textContent ?? "";
    expect(text).toContain("waiting until: the landlord writes back");
    expect(text).not.toContain("275760");
    expect(text).toContain("1 blocked");
  });

  it("a wordless sleep reads as waiting, with no date at all", () => {
    load([{ ...TASK, status: "waiting" }]);
    render(<BatchesTab />);
    fireEvent.click(screen.getByText(BATCH.statement));
    const text = document.body.textContent ?? "";
    expect(text).toContain("· waiting");
    expect(text).not.toContain("waiting until");
    expect(text).not.toContain("275760");
  });
});

describe("the batches tab's detail dialog", () => {
  beforeEach(() => {
    convex.calls.length = 0;
    vi.stubGlobal("open", () => null);
  });

  it("reads the item live: an archived task stops offering verdicts", () => {
    load([TASK]);
    const { rerender } = render(<BatchesTab />);
    openDetail(TASK.statement);
    expect(verdicts()).toEqual(["approve", "revise", "session", "archive"]);

    // The archive verdict lands: the todo comes back archived. The dialog is
    // still open on it, and must now offer nothing to rule.
    load([{ ...TASK, status: "archived" }]);
    rerender(<BatchesTab />);
    expect(verdicts()).toEqual([]);
    // …while still being the dialog it was: this is a read, not a close.
    expect(screen.getAllByText(TASK.statement).length).toBeGreaterThan(0);
  });

  it("closes when the item leaves the graph entirely", () => {
    load([TASK]);
    const { rerender } = render(<BatchesTab />);
    openDetail(TASK.statement);
    expect(screen.getByRole("button", { name: "close" })).toBeTruthy();

    load([]);
    rerender(<BatchesTab />);
    expect(screen.queryByRole("button", { name: "close" })).toBeNull();
  });

  it("rules a goal that lives in a repository on repo and externalId", async () => {
    load([CODE_GOAL]);
    render(<BatchesTab />);
    openDetail(CODE_GOAL.statement);
    fireEvent.click(within(dialog()).getByRole("button", { name: "approve" }));
    await vi.waitFor(() =>
      expect(ruled()).toEqual([
        {
          repo: "tom.quest",
          externalId: "todo-14",
          verdict: "approve",
          sentence: undefined,
        },
      ]),
    );
  });

  it("rules a task on its todo id", async () => {
    load([TASK]);
    render(<BatchesTab />);
    openDetail(TASK.statement);
    fireEvent.click(within(dialog()).getByRole("button", { name: "approve" }));
    await vi.waitFor(() =>
      expect(ruled()).toEqual([
        { todoId: TASK._id, verdict: "approve", sentence: undefined },
      ]),
    );
  });
});
