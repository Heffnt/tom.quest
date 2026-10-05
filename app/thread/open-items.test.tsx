// The open items and their Reply.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NOW, OPEN } from "@/test/fixtures/thread";
import OpenItems from "./open-items";
import ThreadView from "./thread-view";

afterEach(() => cleanup());

describe("OpenItems", () => {
  it("draws the numbered items in order, the older digest's day, the questions and the counts present", () => {
    const { container } = render(<OpenItems open={OPEN} newestDigestId="d1" targetId={null} onReply={() => {}} />);
    const lines = [...container.querySelectorAll("li > [role=button]")].map((one) => one.textContent);
    expect(lines).toEqual([
      "2 · Answer the newest item.",
      "1 · Answer yesterday's item. (of Sun Oct 4)",
      "the bank session asks: Which account?",
    ]);
    const counts = [...container.querySelectorAll("p > a")].map((one) => [one.textContent, one.getAttribute("href")]);
    expect(counts).toEqual([["live sessions 3", "/agents"]]);
  });

  it("expands an item to its links", () => {
    render(<OpenItems open={OPEN} newestDigestId="d1" targetId={null} onReply={() => {}} />);
    fireEvent.click(screen.getByText("2 · Answer the newest item."));
    expect(screen.getByText("The todo's statement").getAttribute("href")).toBe("/jarvis?item=todo1");
    fireEvent.click(screen.getByText("1 · Answer yesterday's item. (of Sun Oct 4)"));
    expect(screen.getByText("calendar")).toBeTruthy();
    fireEvent.click(screen.getByText("the bank session asks: Which account?"));
    expect(screen.getByText("session").getAttribute("href")).toBe("/agents?session=sess1");
  });

  it("expands an unsettled decision and an unanswered suggestion older than the stream's 60 days to all their details", () => {
    const onAccept = vi.fn(async () => {});
    render(<ThreadView days={[]} open={OPEN} loading={false} cuts={[]} onSend={async () => {}} onAccept={onAccept} now={NOW} />);
    fireEvent.click(screen.getByText("Decision: Keep the old run? Keep it."));
    for (const text of ["It still answers.", "job:old", "opus", "0ld00001", "decided by the delegate after waiting 120 minutes"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByText("ruling:old").getAttribute("href")).toBe("/intent");
    expect(screen.getByText("todo").getAttribute("href")).toBe("/jarvis?item=todo9");
    fireEvent.click(screen.getByRole("button", { name: "accept" }));
    expect(onAccept).toHaveBeenCalledWith("0ld00001");
    fireEvent.click(screen.getByRole("button", { name: "object" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe("Object to this decision");
    fireEvent.click(screen.getByText("Suggestion (deletion, proposed): Delete the old page."));
    expect(screen.getByText("drop the old page")).toBeTruthy();
    expect(screen.getByText("ruling r9")).toBeTruthy();
    expect(screen.getByText("old-page").getAttribute("href")).toBe("/design#old-page");
    fireEvent.click(screen.getByRole("button", { name: "yes, no, or a sentence" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe("Yes, no, or a sentence");
  });

  it("links no count that has no destination: with no suggestion, and with one only above the stream", () => {
    const none = { ...OPEN, suggestions: [] };
    const { container } = render(<OpenItems open={none} newestDigestId="d1" targetId={null} onReply={() => {}} />);
    expect([...container.querySelectorAll("a")].map((one) => one.getAttribute("href"))).toEqual(["/agents"]);
    cleanup();
    const { container: aged } = render(<OpenItems open={OPEN} newestDigestId="d1" targetId={null} onReply={() => {}} />);
    expect(aged.querySelector('a[href^="#"]')).toBeNull();
  });

  it("says a count built from a cut read is a lower bound", () => {
    render(<OpenItems open={{ ...OPEN, counts: { liveSessions: 3, partial: ["liveSessions" as const] } }} newestDigestId="d1" targetId={null} onReply={() => {}} />);
    expect(screen.getByText("live sessions at least 3")).toBeTruthy();
  });

  it("selects and prefills each of two items under one digest as its Reply is pressed", () => {
    const onSend = vi.fn(async () => {});
    const [first] = OPEN.needsYou;
    const two = { ...OPEN, needsYou: [first, { ...first, id: "o4" as typeof first.id, key: "k4", n: 3, text: "Answer the third item." }] };
    render(<ThreadView days={[]} open={two} loading={false} cuts={[]} onSend={onSend} onAccept={async () => {}} now={NOW} />);
    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.click(screen.getByText("2 · Answer the newest item. (of Mon Oct 5)"));
    fireEvent.click(screen.getByText("3 · Answer the third item. (of Mon Oct 5)"));
    const [replyTwo, replyThree] = screen.getAllByRole("button", { name: "Reply" });
    fireEvent.click(replyTwo);
    expect(composer.placeholder).toBe("Answer item 2");
    expect(composer.value).toBe("2 ");
    fireEvent.click(replyThree);
    expect(composer.placeholder).toBe("Answer item 3");
    expect(composer.value).toBe("3 ");
    expect(screen.getAllByRole("button", { pressed: true }).map((one) => one.textContent)).toEqual(["Replying"]);
    expect(replyThree.getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(composer, { target: { value: "3 done" } });
    fireEvent.click(screen.getByText("Send"));
    expect(onSend).toHaveBeenCalledWith("3 done", "d1");
  });

  it("sets the composer's target and prefills the number on Reply", () => {
    const onSend = vi.fn(async () => {});
    render(<ThreadView days={[]} open={OPEN} loading={false} cuts={[]} onSend={onSend} onAccept={async () => {}} now={NOW} />);
    fireEvent.click(screen.getByText("2 · Answer the newest item. (of Mon Oct 5)"));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(composer.placeholder).toBe("Answer item 2");
    expect(composer.value).toBe("2 ");
    fireEvent.change(composer, { target: { value: "2 done" } });
    fireEvent.click(screen.getByText("Send"));
    expect(onSend).toHaveBeenCalledWith("2 done", "d1");
  });
});
