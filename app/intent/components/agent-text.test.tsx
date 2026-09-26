// The agent's text is drawn verbatim, block by block, and only a bullet of his
// pages is a control. Every fixture is invented: his pages are private to
// WikiTom and this repository is public.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import AgentText from "./agent-text";
import type { IntentLine } from "../lib";

afterEach(() => cleanup());

const VIEW = {
  prompt: [
    "MODEL-OF-TOM FILES (WikiTom commit abc): model-of-tom/agent-rules.md\n\n── model-of-tom/agent-rules.md ──\n# Agent rules\n\n- Guess nothing.",
    "── model-of-tom/writing.md ──\n# Writing\n\nBe plain.",
    "Skills: `tts-search skills` lists them; `tts-search skills <name>` prints one.",
  ].join("\n\n"),
};

const LINE: IntentLine = {
  id: "model-of-tom/agent-rules.md#3",
  kind: "standing-rule",
  text: "Guess nothing.",
  section: "Agent rules",
  voice: "his",
  source: "model-of-tom/agent-rules.md",
  locator: "line 3",
  at: null,
  dateText: null,
  evidence: [],
};

describe("AgentText", () => {
  it("draws the prompt verbatim, in its own order", () => {
    const { container } = render(<AgentText view={VIEW} lines={[LINE]} selected={null} onSelect={() => {}} />);
    const text = container.textContent ?? "";
    const order = ["MODEL-OF-TOM FILES", "── model-of-tom/writing.md ──", "Skills: `tts-search skills`"]
      .map((needle) => text.indexOf(needle));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("makes a bullet of his pages a control that opens its line, and nothing else", () => {
    const onSelect = vi.fn();
    const { getAllByRole } = render(<AgentText view={VIEW} lines={[LINE]} selected={null} onSelect={onSelect} />);
    const buttons = getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("- Guess nothing.his");
    fireEvent.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith(LINE);
  });
});
