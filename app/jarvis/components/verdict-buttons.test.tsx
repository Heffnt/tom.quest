// The verdict row, pinned: the four words convex/ttsRulings.ts accepts and
// nothing else, each wired to recordRuling with that verdict, each with the
// popover naming the call (app/AGENTS.md UI rules: the popover is the contract,
// and a label names its exact backend effect). Rendered by the options row, so
// it is checked through the one component and through that row.
//
// None of this is visible to a type checker: a fifth button, a button whose
// popover names another verdict, or a revise that records with no sentence
// all compile.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { api } from "@/convex/_generated/api";
import VerdictButtons from "./verdict-buttons";
import OptionsRow from "./options-row";
import TodoRow from "./todo-row";
import { VERDICTS as LIB_VERDICTS, type Todo } from "../lib";

// The four words, spelled out once. lib.VERDICTS is asserted equal to them
// below, which is what lets the popover contract test derive its allowed set
// from lib rather than restating the literals a third time.
const VERDICTS = ["approve", "revise", "session", "archive"] as const;

// OptionsRow is the one component here that talks to Convex. The mutations are
// spies: what matters is which call each chip fires and with what.
const mutations = vi.hoisted(() => ({
  calls: [] as { ref: unknown; args: unknown }[],
  /** Set to a message to make the next call refuse, as Convex does. */
  refuse: null as string | null,
}));

vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: (ref: unknown) => async (args: unknown) => {
    if (mutations.refuse !== null) throw new Error(mutations.refuse);
    mutations.calls.push({ ref, args });
  },
}));

// The row reaches the session launcher, which reaches app/lib/auth, whose
// Sentry import does not load under jsdom. Nothing here reads the auth state:
// every mutation on this surface is refused by Convex, not by the client.
vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ isTom: true, canReadSurface: () => true }),
}));

/** The arguments each call to `api.<module>.<function>` was fired with. */
function fired(fn: unknown): unknown[] {
  return mutations.calls
    .filter((c) => getFunctionName(c.ref as never) === getFunctionName(fn as never))
    .map((c) => c.args);
}

const TODO = {
  _id: "todo-1",
  _creationTime: 0,
  statement: "Ratify the amendment",
  status: "active",
  readiness: "prepared",
} as unknown as Todo;

/** The action buttons in a container — every button that is not a ⓘ. */
function actions(container: HTMLElement | Document = document.body): HTMLButtonElement[] {
  return within(container as HTMLElement)
    .queryAllByRole("button")
    .filter((b) => b.getAttribute("aria-label") !== "what this does") as HTMLButtonElement[];
}

/** The ⓘ rendered beside an action button (the same inline-flex wrapper). */
function infoBeside(button: HTMLElement): HTMLElement {
  const info = button.parentElement?.querySelector('[aria-label="what this does"]');
  if (!info) throw new Error(`no popover beside "${button.textContent}"`);
  return info as HTMLElement;
}

describe("the verdict row", () => {
  it("is the same four words lib.VERDICTS holds, in the same order", () => {
    // Everything else in this file, and the popover contract test, reads the
    // set from lib. This is the one place the four words are written out.
    expect(LIB_VERDICTS).toEqual([...VERDICTS]);
  });

  it("is exactly the four verdict words, in the mutation's order — no edit", () => {
    render(<VerdictButtons subject="todo" statement="s" onRule={() => {}} />);
    expect(actions().map((b) => b.textContent)).toEqual([...VERDICTS]);
  });

  for (const subject of ["todo", "code"] as const) {
    it(`on a ${subject}: every button's popover names recordRuling with that verdict on the ${subject}`, () => {
      render(<VerdictButtons subject={subject} statement="s" onRule={() => {}} />);
      const field = subject === "code" ? "repo, externalId" : "todoId";
      for (const verdict of VERDICTS) {
        fireEvent.click(infoBeside(screen.getByRole("button", { name: verdict })));
        expect(
          screen.getByText(
            `ttsRulings.recordRuling({ ${field}, verdict: "${verdict}", sentence })`,
          ),
        ).toBeTruthy();
        fireEvent.keyDown(document, { key: "Escape" });
      }
    });
  }

  it("approve and session record on the press, with no sentence", async () => {
    const onRule = vi.fn(async () => {});
    render(<VerdictButtons subject="todo" statement="s" onRule={onRule} />);
    const approve = screen.getByRole("button", { name: "approve" });
    fireEvent.click(approve);
    // Called inside the press itself, before any await — the session verdict
    // reserves its browser tab there and browsers honour that only in the
    // gesture stack.
    expect(onRule).toHaveBeenLastCalledWith("approve", "");
    // The row is busy until the ruling settles; a second press then is
    // refused rather than recorded twice.
    expect(approve.hasAttribute("disabled")).toBe(true);
    await vi.waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "session" }));
    expect(onRule).toHaveBeenLastCalledWith("session", "");
    expect(onRule).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
  });

  it("revise opens the dialog and records only once there is a sentence", async () => {
    const onRule = vi.fn(async () => {});
    render(<VerdictButtons subject="todo" statement="s" onRule={onRule} />);
    fireEvent.click(screen.getByRole("button", { name: "revise" }));
    expect(onRule).not.toHaveBeenCalled();

    const confirm = screen.getByRole("button", { name: "record revise" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  split the turing items out  " },
    });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);
    expect(onRule).toHaveBeenCalledWith("revise", "split the turing items out");
    // Closed on success — a stale overlay would hide the card it came from.
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "record revise" })).toBeNull(),
    );
  });

  it("archive opens the dialog and records with or without a sentence", () => {
    const onRule = vi.fn(async () => {});
    render(<VerdictButtons subject="todo" statement="s" onRule={onRule} />);
    fireEvent.click(screen.getByRole("button", { name: "archive" }));
    const confirm = screen.getByRole("button", { name: "record archive" });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);
    expect(onRule).toHaveBeenCalledWith("archive", "");
  });

  it("the dialog's confirm carries the same popover as the button that opened it", () => {
    render(<VerdictButtons subject="todo" statement="s" onRule={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "archive" }));
    const confirm = screen.getByRole("button", { name: "record archive" });
    fireEvent.click(infoBeside(confirm));
    expect(
      screen.getByText('ttsRulings.recordRuling({ todoId, verdict: "archive", sentence })'),
    ).toBeTruthy();
  });

  it("shows a handler that refuses synchronously, before any await", async () => {
    // A caller whose todo is gone throws rather than recording a session
    // ruling it cannot open a session for, which would pin the item in "ruled,
    // applying" for good. onRule is called inside the press, so the throw
    // arrives before the first await.
    const onRule = vi.fn(() => {
      throw new Error("TTS todo not found — reload the page");
    });
    render(<VerdictButtons subject="todo" statement="s" onRule={onRule} />);
    const session = screen.getByRole("button", { name: "session" });
    fireEvent.click(session);
    await vi.waitFor(() =>
      expect(screen.getByText("TTS todo not found — reload the page")).toBeTruthy(),
    );
    // And the row is usable again rather than stuck busy.
    expect(session.hasAttribute("disabled")).toBe(false);
  });

  it("shows an error the caller holds instead of throwing", () => {
    // The session launch hooks catch their own failures into state; a session
    // verdict whose session never opened has to say so on this row.
    render(
      <VerdictButtons
        subject="todo"
        statement="s"
        error="the session did not open"
        onRule={() => {}}
      />,
    );
    expect(screen.getByText("the session did not open")).toBeTruthy();
  });

  it("shows a refused ruling under the row instead of swallowing it", async () => {
    const onRule = vi.fn(async () => {
      throw new Error("Not authorised: TTS");
    });
    render(<VerdictButtons subject="todo" statement="s" onRule={onRule} />);
    fireEvent.click(screen.getByRole("button", { name: "approve" }));
    await vi.waitFor(() =>
      expect(screen.getByText("Not authorised: TTS")).toBeTruthy(),
    );
  });
});

describe("the todo row", () => {
  // witness: drop the must-not-break block from todo-row.tsx — Tom's
  // constraint would be stored and shown nowhere on the page.
  it("shows Tom's must-not-break line on a goal, with the popover naming the pen", () => {
    render(
      <TodoRow
        todo={
          {
            ...TODO,
            kind: "goal",
            mustNotBreak: "the citations stay verbatim",
            source: "tom",
            timingClass: "whenever",
            createdAt: 0,
            updatedAt: 0,
          } as unknown as Todo
        }
        now={Date.now()}
        expanded
        onToggle={() => {}}
        intent={null}
        onIntentCleared={() => {}}
        timeNotes={[]}
      />,
    );
    expect(screen.getByText("the citations stay verbatim")).toBeTruthy();
    fireEvent.click(infoBeside(screen.getByText("must not break")));
    expect(screen.getByText("tts.updateTodo({ mustNotBreak })")).toBeTruthy();
  });
});

// ── The options row ─────────────────────────────────────────────────────────
// The row a life todo and a code item carry. It renders the SAME verdict row —
// not a second set of chips — and it composes nothing between its chips: the row sits inside an expanded panel,
// and an input appearing there moves everything under it (app/AGENTS.md UI rules:
// interactions never shift layout; anything composed opens in a fixed dialog).
describe("the options row", () => {
  beforeEach(() => {
    mutations.calls.length = 0;
    mutations.refuse = null;
    // reserveSessionTab claims the tab inside the press; jsdom has no real one.
    vi.stubGlobal("open", () => null);
  });

  it("offers the four verdicts plus done, each with a popover", () => {
    render(<OptionsRow todo={TODO} rulable />);
    expect(actions().map((b) => b.textContent)).toEqual([...VERDICTS, "done"]);
    for (const b of actions()) infoBeside(b);
  });

  it("names recordRuling on the todo in every verdict's popover", () => {
    render(<OptionsRow todo={TODO} rulable />);
    for (const verdict of VERDICTS) {
      fireEvent.click(infoBeside(screen.getByRole("button", { name: verdict })));
      expect(
        screen.getByText(
          `ttsRulings.recordRuling({ todoId, verdict: "${verdict}", sentence })`,
        ),
      ).toBeTruthy();
      fireEvent.keyDown(document, { key: "Escape" });
    }
  });

  it("names recordRuling on the repository entry for a code subject", () => {
    render(
      <OptionsRow
        code={{ repo: "tom.quest", externalId: "todo-14" }}
        statement="Fence the session repo list"
        rulable
      />,
    );
    fireEvent.click(infoBeside(screen.getByRole("button", { name: "revise" })));
    expect(
      screen.getByText(
        'ttsRulings.recordRuling({ repo, externalId, verdict: "revise", sentence })',
      ),
    ).toBeTruthy();
  });

  it("composes revise in the fixed dialog, never in the row", async () => {
    const { container } = render(<OptionsRow todo={TODO} rulable />);
    fireEvent.click(screen.getByRole("button", { name: "revise" }));
    // The row itself gained nothing: no input appeared between the chips.
    expect(within(container).queryByRole("textbox")).toBeNull();
    // The dialog is a fixed overlay outside the row's own subtree.
    const confirm = screen.getByRole("button", { name: "record revise" });
    expect(container.contains(confirm)).toBe(false);
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  split the turing items out  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "record revise" }));
    await vi.waitFor(() =>
      expect(fired(api.ttsRulings.recordRuling)).toEqual([
        {
          todoId: TODO._id,
          verdict: "revise",
          sentence: "split the turing items out",
        },
      ]),
    );
  });

  it("records the session verdict, then hands the reserved tab on", async () => {
    const afterSession = vi.fn();
    render(<OptionsRow todo={TODO} rulable afterSession={afterSession} />);
    fireEvent.click(screen.getByRole("button", { name: "session" }));
    await vi.waitFor(() => expect(afterSession).toHaveBeenCalledTimes(1));
    expect(fired(api.ttsRulings.recordRuling)).toEqual([
      { todoId: TODO._id, verdict: "session", sentence: undefined },
    ]);
    expect(afterSession.mock.calls[0][1]).toEqual({
      verdict: "session",
      sentence: undefined,
    });
  });

  it("composes the status chips in the same dialog, not in the row", async () => {
    const waiting = { ...TODO, readiness: "unprepared" } as Todo;
    const { container } = render(<OptionsRow todo={waiting} rulable={false} />);
    // Not rulable: the two status chips only, and archive here is the status
    // write rather than the verdict.
    expect(actions().map((b) => b.textContent)).toEqual(["done", "archive"]);

    fireEvent.click(screen.getByRole("button", { name: "archive" }));
    expect(within(container).queryByRole("textbox")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "when the box is back" },
    });
    fireEvent.click(screen.getByRole("button", { name: "archive it" }));
    await vi.waitFor(() =>
      expect(fired(api.tts.setStatus)).toEqual([
        {
          id: waiting._id,
          status: "archived",
          unarchiveCondition: "when the box is back",
        },
      ]),
    );
  });

  it("shows a refused status write in the dialog it was composed in", async () => {
    render(<OptionsRow todo={TODO} rulable={false} />);
    fireEvent.click(screen.getByRole("button", { name: "done" }));
    mutations.refuse = "Not authorised: TTS";
    fireEvent.click(screen.getByRole("button", { name: "mark done" }));
    await vi.waitFor(() =>
      expect(screen.getByText("Not authorised: TTS")).toBeTruthy(),
    );
  });
});
