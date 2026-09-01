// What the ⓘ caption control has to do, pinned.
//
// The ratified rule (CLAUDE.md, Tom 2026-08-29) is one info mechanism: a
// tap-to-open popover, never hover-only and never the browser's own `title`
// attribute, because both of those are unopenable on a touch screen. The
// writing standard (WRITING_STANDARD in convex/ttsShared.ts) then splits what
// the popover carries into two registers: display text, short and always
// visible once open, and a ground-up explanation, self-contained and shown
// fullscreen behind a "more" control.
//
// Every test below is one of those requirements. They exist because all of
// them are invisible to a type checker: a popover that opens only on hover, a
// "more" that appears with nothing behind it, or a caption whose press also
// fires the row it sits in all compile perfectly.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Info from "./info";

const DOC = `<!DOCTYPE html><html><head><style>body{background:#0a0e17}</style></head><body><h1>What readiness is</h1></body></html>`;

describe("Info caption", () => {
  it("shows nothing until it is pressed, then opens on the press", () => {
    render(
      <Info call="tts.updateTodo({ readiness })">Sets how far it has got.</Info>,
    );
    expect(screen.queryByText("Sets how far it has got.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "what this does" }));
    expect(screen.getByText("Sets how far it has got.")).toBeTruthy();
    expect(screen.getByText("tts.updateTodo({ readiness })")).toBeTruthy();
  });

  it("does not fire the row it sits inside", () => {
    // The ⓘ is usually inside a todo row that opens its own detail on click.
    // Asking what a control does must not also do it.
    let rowClicks = 0;
    render(
      <div onClick={() => (rowClicks += 1)}>
        <Info call="tts.setStatus({ status: 'done' })">Marks it done.</Info>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "what this does" }));
    expect(rowClicks).toBe(0);
    expect(screen.getByText("Marks it done.")).toBeTruthy();
  });

  it("offers no 'more' when no ground-up explanation was written", () => {
    render(<Info call="tts.deleteTimeNote({ id })">Deletes the note.</Info>);
    fireEvent.click(screen.getByRole("button", { name: "what this does" }));
    expect(screen.queryByText("more")).toBeNull();
  });

  it("opens the ground-up explanation fullscreen behind 'more'", () => {
    render(
      <Info
        call="tts.updateTodo({ readiness })"
        explanation={DOC}
        explanationTitle="readiness — the field this dropdown writes"
      >
        Sets how far the preparing has got.
      </Info>,
    );
    fireEvent.click(screen.getByRole("button", { name: "what this does" }));
    fireEvent.click(screen.getByText("more"));

    // The document renders in a sandboxed iframe, which is what makes a page
    // written by an agent safe to show: no script in it can run.
    const frame = document.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toBe(DOC);
    expect(
      screen.getByText("readiness — the field this dropdown writes"),
    ).toBeTruthy();

    // The panel it was opened from is gone: it is absolutely positioned
    // against a control that may have scrolled away underneath.
    expect(screen.queryByText("Sets how far the preparing has got.")).toBeNull();

    fireEvent.click(screen.getByText("close"));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("closes the fullscreen explanation on Escape", () => {
    render(
      <Info call="tts.updateTodo({ readiness })" explanation={DOC}>
        Sets how far the preparing has got.
      </Info>,
    );
    fireEvent.click(screen.getByRole("button", { name: "what this does" }));
    fireEvent.click(screen.getByText("more"));
    expect(document.querySelector("iframe")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector("iframe")).toBeNull();
  });
});
