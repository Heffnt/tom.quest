// The verdict row, pinned: the four words convex/ttsRulings.ts accepts and
// nothing else, each wired to recordRuling with that verdict, each with the
// popover naming the call (CLAUDE.md UI rules: the popover is the contract,
// and a label names its exact backend effect). Rendered on the batch card and
// in the detail dialog, so both surfaces are checked through the one
// component and through themselves.
//
// None of this is visible to a type checker: a fifth button, a button whose
// popover names another verdict, a revise that records with no sentence, or
// a detail item that offers verdicts it cannot rule all compile.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import VerdictButtons from "./verdict-buttons";
import BatchCard, { type BatchGraph } from "./batch-card";
import DetailDialog from "./detail-dialog";

const VERDICTS = ["approve", "revise", "session", "archive"] as const;

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

const GRAPH: BatchGraph = {
  id: "batch-1",
  statement: "Land the lifeos update",
  groundUp: "<!DOCTYPE html><html><body><p>why</p></body></html>",
  tasks: [
    {
      id: "t1",
      statement: "Write the spec amendment",
      actor: "agent",
      status: "done",
      needs: [],
      rulable: false,
    },
    {
      id: "t2",
      statement: "Ratify the amendment",
      actor: "tom",
      status: "active",
      needs: ["t1"],
      rulable: true,
    },
  ],
  goals: [
    { id: "g1", statement: "The spec says what the system does", met: false, rulable: false },
  ],
};

describe("the verdict row", () => {
  it("is exactly the four verdict words, in the mutation's order — no edit", () => {
    render(<VerdictButtons subject="batch" statement="s" onRule={() => {}} />);
    expect(actions().map((b) => b.textContent)).toEqual([...VERDICTS]);
  });

  for (const subject of ["batch", "todo"] as const) {
    it(`on a ${subject}: every button's popover names recordRuling with that verdict on the ${subject}`, () => {
      render(<VerdictButtons subject={subject} statement="s" onRule={() => {}} />);
      const field = subject === "batch" ? "batchId" : "todoId";
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
    render(<VerdictButtons subject="batch" statement="s" onRule={onRule} />);
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
    render(<VerdictButtons subject="batch" statement="s" onRule={onRule} />);
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
    render(<VerdictButtons subject="batch" statement="s" onRule={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "archive" }));
    const confirm = screen.getByRole("button", { name: "record archive" });
    fireEvent.click(infoBeside(confirm));
    expect(
      screen.getByText('ttsRulings.recordRuling({ batchId, verdict: "archive", sentence })'),
    ).toBeTruthy();
  });

  it("shows a refused ruling under the row instead of swallowing it", async () => {
    const onRule = vi.fn(async () => {
      throw new Error("Not authorised: TTS");
    });
    render(<VerdictButtons subject="batch" statement="s" onRule={onRule} />);
    fireEvent.click(screen.getByRole("button", { name: "approve" }));
    await vi.waitFor(() =>
      expect(screen.getByText("Not authorised: TTS")).toBeTruthy(),
    );
  });
});

describe("the batch card", () => {
  it("expanded: the session opener and the four verdicts, each with a popover", () => {
    render(
      <BatchCard
        graph={GRAPH}
        expanded
        onToggle={() => {}}
        onRule={() => {}}
        onDetail={() => {}}
        onGroundUp={() => {}}
        onOpenSession={() => {}}
      />,
    );
    const labels = actions().map((b) => b.textContent);
    expect(labels).toContain("open batch session");
    for (const v of VERDICTS) expect(labels).toContain(v);
    expect(labels).not.toContain("edit");

    fireEvent.click(infoBeside(screen.getByRole("button", { name: "open batch session" })));
    expect(
      screen.getByText(
        'claudeSessions.createSession({ kind: "focus-item", batchId, initialPrompt })',
      ),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    for (const v of VERDICTS) {
      infoBeside(screen.getByRole("button", { name: v }));
    }
  });
});

describe("the detail dialog", () => {
  const noop = () => {};

  it("offers the four verdicts on the batch", () => {
    render(
      <DetailDialog
        item={{ kind: "batch", graph: GRAPH }}
        onClose={noop}
        onGroundUp={noop}
        onRule={() => {}}
      />,
    );
    const labels = actions().map((b) => b.textContent);
    expect(labels.slice(0, 4)).toEqual([...VERDICTS]);
  });

  it("offers them on a rulable task and withholds them on one that is not", () => {
    const rulable = GRAPH.tasks[1];
    const { unmount } = render(
      <DetailDialog
        item={{ kind: "task", batchStatement: GRAPH.statement, task: rulable, waitingOn: [] }}
        onClose={noop}
        onGroundUp={noop}
        onRule={() => {}}
      />,
    );
    expect(actions().map((b) => b.textContent).slice(0, 4)).toEqual([...VERDICTS]);
    unmount();

    const done = GRAPH.tasks[0];
    render(
      <DetailDialog
        item={{ kind: "task", batchStatement: GRAPH.statement, task: done, waitingOn: [] }}
        onClose={noop}
        onGroundUp={noop}
        onRule={() => {}}
      />,
    );
    for (const v of VERDICTS) {
      expect(screen.queryByRole("button", { name: v })).toBeNull();
    }
  });

  it("routes a verdict to the item it was opened on", () => {
    const onRule = vi.fn();
    const item = { kind: "goal" as const, batchStatement: GRAPH.statement, goal: { ...GRAPH.goals[0], rulable: true } };
    render(<DetailDialog item={item} onClose={noop} onGroundUp={noop} onRule={onRule} />);
    fireEvent.click(screen.getByRole("button", { name: "approve" }));
    expect(onRule).toHaveBeenCalledWith(item, "approve", "");
  });

  it("offers no verdicts when nothing records them (the mockup route)", () => {
    render(
      <DetailDialog item={{ kind: "batch", graph: GRAPH }} onClose={noop} onGroundUp={noop} />,
    );
    for (const v of VERDICTS) {
      expect(screen.queryByRole("button", { name: v })).toBeNull();
    }
  });
});
