
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CHANGES, MESSAGES, NOW } from "@/test/fixtures/thread";
import { buildDays } from "./feed";
import ThreadView from "./thread-view";

afterEach(() => cleanup());

function draw(onSend = vi.fn(async () => {}), onAccept = vi.fn(async () => {})) {
  const view = render(<ThreadView days={buildDays([], [], MESSAGES, CHANGES, NOW)} open={undefined} loading={false}
    cuts={[]} onSend={onSend} onAccept={onAccept} now={NOW} />);
  return { ...view, onSend, onAccept };
}

const row = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[id="${id}"]`)!;
const press = (text: string) => fireEvent.click(screen.getByText(text));
const composer = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("ThreadView", () => {

  it("draws each folded line as the contract states it", () => {
    const { container } = draw();
    for (const word of ["fact", "todo", "rule", "errand", "question", "answer", "leaving", "back", "issue", "no-issues"]) {
      const message = row(container, `m-${word}`);
      expect(within(message).getByText(`Message classed ${word}.`)).toBeTruthy();
      expect(within(message).getByText(word)).toBeTruthy();
      expect(within(message).getByText(`Reply of type ${word}.`)).toBeTruthy();
    }
    expect(row(container, "d1").textContent).toContain("digest · today 2 · objections 1 · needs-you-today 2 · calendar 3 · spend 1");
    expect(row(container, "a1").textContent).toContain("Jarvis · silence alarmThe digest cron is silent.agents");
    expect(within(row(container, "a1")).getByText("agents").getAttribute("href")).toBe("https://tom.quest/agents?view=window");
    expect(row(container, "i1").textContent).toContain("Jarvis · needs you");
    expect(row(container, "i1").textContent).toContain("2 ·Late item.");
    expect(screen.getByText("Merged tom.quest #341: thread: one page · on checks alone")).toBeTruthy();
    expect(screen.getByText("Decision: One session or two? One.")).toBeTruthy();
    expect(screen.getByText("Decision: Move the run. Thursday.")).toBeTruthy();
    expect(within(row(container, "dec2")).getByText("stands")).toBeTruthy();
    expect(screen.getByText("Suggestion (landing, built): Landed the fix.")).toBeTruthy();
    expect(screen.getByText("Suggestion (deletion, proposed): Delete the log page.")).toBeTruthy();
    expect(screen.getByText("digest: size failed, 9 against 4")).toBeTruthy();
    expect(screen.getByText("The digest grew.")).toBeTruthy();
    expect(screen.getByText("Deployed tom.quest aaaa111..bbbb222, 1 commit(s)")).toBeTruthy();
    // His objection is nested under the decision it answers.
    expect(row(container, "obj1").previousElementSibling?.id).toBe("dec1");
  });

  it("expands a row on press to its fields and controls, and folds it again", () => {
    const { container } = draw();
    expect(screen.queryByText("The digest text.")).toBeNull();
    press("digest · today 2 · objections 1 · needs-you-today 2 · calendar 3 · spend 1");
    expect(screen.getByText("The digest text.")).toBeTruthy();
    expect(screen.getByText("Item one.")).toBeTruthy();
    expect(screen.getByText("Item 1: its todo is marked done.")).toBeTruthy();
    expect(within(row(container, "d1")).getByRole("button", { name: "Reply" })).toBeTruthy();
    press("digest · today 2 · objections 1 · needs-you-today 2 · calendar 3 · spend 1");
    expect(screen.queryByText("The digest text.")).toBeNull();

    press("Merged tom.quest #341: thread: one page · on checks alone");
    expect(screen.getByText("The thread is the one page.")).toBeTruthy();
    expect(screen.getByText("The thread page · added")).toBeTruthy();
    expect(screen.getByText("log-page · removed")).toBeTruthy();

    press("Decision: One session or two? One.");
    const decision = row(container, "dec1");
    expect(within(decision).getByText("His pages say one.")).toBeTruthy();
    expect(within(decision).getByText("would change: If the queue fell behind.")).toBeTruthy();
    expect(within(decision).getByText("ruling:abc").getAttribute("href")).toBe("/intent");
    expect(within(decision).getByText("todo").getAttribute("href")).toBe("/jarvis?item=todo1");
    expect(within(decision).getByRole("button", { name: "accept" })).toBeTruthy();
    expect(within(decision).getByRole("button", { name: "object" })).toBeTruthy();

    expect(within(decision).getByText("decided by the delegate after waiting 120 minutes")).toBeTruthy();

    // His own decision says so and takes no accept or object.
    press("Decision: Which bank? The credit union.");
    expect(within(row(container, "dec3")).getByText("decided by Tom after 12 minutes")).toBeTruthy();
    expect(within(row(container, "dec3")).queryByRole("button", { name: "accept" })).toBeNull();
    expect(within(row(container, "dec3")).queryByRole("button", { name: "object" })).toBeNull();

    press("Decision: Move the run. Thursday.");
    expect(within(row(container, "dec2")).queryByRole("button", { name: "accept" })).toBeNull();

    press("Suggestion (landing, built): Landed the fix.");
    expect(screen.getByText("fix it")).toBeTruthy();
    expect(screen.getByText("tom.quest@abcdef1").getAttribute("href")).toBe("https://github.com/Heffnt/tom.quest/commit/abcdef1");

    fireEvent.click(within(row(container, "g1")).getByRole("button", { expanded: false }));
    expect(screen.getByText("1 · code · The digest grew.")).toBeTruthy();
    expect(screen.getByText("fix").getAttribute("href")).toBe("#ch1");
  });

  it("gives each type its reply target, and none to an alarm or his own message", () => {
    const { container, onSend } = draw();
    expect(within(row(container, "a1")).queryByRole("button")).toBeNull();
    expect(within(row(container, "m-fact")).queryByRole("button")).toBeNull();

    press("Decision: One session or two? One.");
    fireEvent.click(within(row(container, "dec1")).getByRole("button", { name: "object" }));
    expect(composer().placeholder).toBe("Object to this decision");

    fireEvent.click(within(row(container, "i1")).getByRole("button", { name: "Reply" }));
    expect(composer().placeholder).toBe("Answer item 2");
    expect(composer().value).toBe("2 ");

    press("Suggestion (deletion, proposed): Delete the log page.");
    fireEvent.click(screen.getByRole("button", { name: "yes, no, or a sentence" }));
    expect(composer().placeholder).toBe("Yes, no, or a sentence");

    press("digest: size failed, 9 against 4");
    fireEvent.click(within(row(container, "c1")).getByRole("button", { name: "Reply" }));
    expect(composer().placeholder).toBe("Reply under this line");

    fireEvent.click(within(row(container, "ch2")).getByRole("button", { name: "Reply" }));
    expect(composer().placeholder).toBe("Reply to Jarvis");
    // A second press clears the target.
    fireEvent.click(within(row(container, "ch2")).getByRole("button", { name: "Replying" }));
    expect(composer().placeholder).toBe("Message Jarvis");

    fireEvent.click(within(row(container, "ch2")).getByRole("button", { name: "Reply" }));
    fireEvent.change(composer(), { target: { value: "Why this?" } });
    press("Send");
    expect(onSend).toHaveBeenCalledWith("Why this?", "ch2");
  });

  it("accepts a decision through settle, and shows a refusal under the control", async () => {
    const onAccept = vi.fn(async () => {
      throw new Error("decision 86f2f341 was refused or not answered; there is nothing to accept");
    });
    const { container } = draw(undefined, onAccept);
    press("Decision: One session or two? One.");
    fireEvent.click(within(row(container, "dec1")).getByRole("button", { name: "accept" }));
    expect(onAccept).toHaveBeenCalledWith("86f2f341");
    expect(await screen.findByText(/^not recorded: decision 86f2f341/)).toBeTruthy();
  });

  it("folds a digest to every section it counted but the settled run, a superseded ruling's among them", () => {
    const [digest] = MESSAGES.filter((one) => one.kind === "digest");
    const superseded = { ...digest, sectionCounts: { today: 1, settled: 2, superseded: 1, "needs-you-today": 1 } };
    render(<ThreadView days={buildDays([], [], [superseded] as typeof MESSAGES, [], NOW)} open={undefined} loading={false} cuts={[]}
      onSend={async () => {}} onAccept={async () => {}} now={NOW} />);
    expect(screen.getByText("digest · today 1 · superseded 1 · needs-you-today 2")).toBeTruthy();
  });

  it("draws a reply the budget cut as unknown, never as not processed yet", () => {
    const [digest] = MESSAGES.filter((one) => one.kind === "digest");
    const rows = [{ kind: "message", id: "m-cut", at: NOW - 60_000, text: "Cut.", subject: null, reply: { cut: true } },
      { ...digest, replies: [{ id: "r9", at: NOW - 50_000, text: "1 done", reply: { cut: true } }] }];
    render(<ThreadView days={buildDays([], [], rows as unknown as typeof MESSAGES, [], NOW)} open={undefined} loading={false} cuts={[]}
      onSend={async () => {}} onAccept={async () => {}} now={NOW} />);
    press("digest · today 2 · objections 1 · needs-you-today 2 · calendar 3 · spend 1");
    expect(screen.getByText("Cut.")).toBeTruthy();
    expect(screen.getByText("1 done")).toBeTruthy();
    expect(screen.queryByText("not processed yet")).toBeNull();
  });

  it("draws a line for each read of the stream that stopped before its last row", () => {
    render(<ThreadView days={[]} open={undefined} loading={false} cuts={["Thread messages: 500 read, stopped at the row limit."]}
      onSend={async () => {}} onAccept={async () => {}} now={NOW} />);
    expect(screen.getByText("Thread messages: 500 read, stopped at the row limit.")).toBeTruthy();
  });

  it("draws a folded line on one line, truncated, and wraps it once pressed", () => {
    draw();
    const line = screen.getByText("Suggestion (deletion, proposed): Delete the log page.");
    expect(line.className).toContain("truncate");
    expect(line.className).not.toContain("break-words");
    press("Suggestion (deletion, proposed): Delete the log page.");
    expect(line.className).not.toContain("truncate");
    expect(line.className).toContain("break-words");
  });

  it("draws an answered suggestion's answer once, and no reply under a row as pending", () => {
    const { container } = draw();
    // Folded, the answer's message is not drawn as a second line under the row.
    expect(screen.queryByText("yes, keep it gone")).toBeNull();
    press("Suggestion (deletion, built): Deleted the push page.");
    expect(screen.getAllByText("yes, keep it gone")).toHaveLength(1);
    expect(row(container, "ans1")).toBeNull();
    // His objection under a decision is answered by the decision's path, not
    // the box's: it is not shown as waiting.
    expect(within(row(container, "obj1")).queryByText("not processed yet")).toBeNull();
  });

});
