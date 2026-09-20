import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { BANK } from "./data/types";
import QuestionsClient from "./questions-client";
import { kindOf, matches, shuffled, type Filters } from "./lib/pick";

const FRESH_SEED = 1;
const freshOrder = () => shuffled(BANK, FRESH_SEED);

const settingsMock = vi.hoisted(() => ({
  stored: { seen: [] as string[], seed: 0 },
  rerender: null as (() => void) | null,
  storeSettings: vi.fn(),
}));

vi.mock("@/app/lib/hooks/use-persisted-settings", () => ({
  usePersistedSettings: () => [settingsMock.stored, settingsMock.storeSettings, true],
}));

vi.mock("@/app/components/tom-gate", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

function StatefulQuestions() {
  const [, setVersion] = useState(0);

  useEffect(() => {
    settingsMock.rerender = () => setVersion((version) => version + 1);
    return () => {
      settingsMock.rerender = null;
    };
  }, []);

  return <QuestionsClient />;
}

function renderQuestions(
  { seen = [], seed = 0 }: { seen?: string[]; seed?: number } = {},
  clearStoredWrites = true,
) {
  settingsMock.stored = { seen, seed };
  settingsMock.storeSettings.mockReset();
  settingsMock.storeSettings.mockImplementation((patch: { seen?: string[]; seed?: number }) => {
    settingsMock.stored = { ...settingsMock.stored, ...patch };
    settingsMock.rerender?.();
  });
  const result = render(<StatefulQuestions />);
  if (clearStoredWrites) settingsMock.storeSettings.mockClear();
  return result;
}

function rowFor(question: (typeof BANK)[number]) {
  const row = screen
    .getAllByRole("button")
    .find((button) => button.textContent?.includes(question.text));
  if (!row) throw new Error(`Could not find the row for ${question.id}`);
  return row;
}

function openDrawer(content: "options" | "list") {
  const opener = screen.getByRole("button", { name: content === "options" ? "options" : `list ${BANK.length}` });
  fireEvent.click(opener);
  return { opener, dialog: screen.getByRole("dialog", { name: content }) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  settingsMock.stored = { seen: [], seed: 0 };
  settingsMock.rerender = null;
  settingsMock.storeSettings.mockReset();
});

describe("QuestionsClient", () => {
  it("shows the first shuffled question with prev disabled, next enabled, and 1 of 53 on a fresh load", () => {
    renderQuestions();

    expect(screen.getByText(freshOrder()[0].text)).toBeTruthy();
    expect(screen.getByRole("button", { name: "prev" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "next" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/^1 of 53/)).toBeTruthy();
  });

  it("leaves the question and settings unchanged when a disabled step is clicked", () => {
    renderQuestions();

    fireEvent.click(screen.getByRole("button", { name: "prev" }));

    expect(screen.getByText(freshOrder()[0].text)).toBeTruthy();
    expect(settingsMock.storeSettings).not.toHaveBeenCalled();
  });

  it("moves next to the second shuffled question, enables prev, and stores the left id and seed", () => {
    renderQuestions();

    fireEvent.click(screen.getByRole("button", { name: "next" }));

    expect(screen.getByText(freshOrder()[1].text)).toBeTruthy();
    expect(screen.getByRole("button", { name: "prev" }).hasAttribute("disabled")).toBe(false);
    expect(settingsMock.storeSettings).toHaveBeenLastCalledWith({ seen: [freshOrder()[0].id], seed: FRESH_SEED });
  });

  it("moves prev and stores the question it left", () => {
    renderQuestions();
    fireEvent.click(screen.getByRole("button", { name: "next" }));

    fireEvent.click(screen.getByRole("button", { name: "prev" }));

    expect(screen.getByText(freshOrder()[0].text)).toBeTruthy();
    expect(settingsMock.storeSettings).toHaveBeenLastCalledWith({
      seen: [freshOrder()[0].id, freshOrder()[1].id],
      seed: FRESH_SEED,
    });
  });

  it("mirrors each seen change once despite persisted-state rerenders and leaves filter changes alone", () => {
    renderQuestions();

    fireEvent.click(screen.getByRole("button", { name: "next" }));
    expect(settingsMock.storeSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "prev" }));
    expect(settingsMock.storeSettings).toHaveBeenCalledTimes(2);

    const { dialog } = openDrawer("options");
    fireEvent.click(within(dialog).getByRole("button", { name: "reset seen" }));
    expect(settingsMock.storeSettings).toHaveBeenCalledTimes(3);

    fireEvent.click(within(dialog).getByRole("button", { name: "1" }));
    expect(settingsMock.storeSettings).toHaveBeenCalledTimes(3);
  });

  it("marks the final shuffled question seen when leaving it with prev", () => {
    renderQuestions();

    for (let index = 1; index < BANK.length; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "next" }));
    }

    const next = screen.getByRole("button", { name: "next" });
    expect(screen.getByText(freshOrder().at(-1)?.text ?? "")).toBeTruthy();
    expect(next).toBeTruthy();
    expect(next.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "prev" }));

    expect(settingsMock.storeSettings).toHaveBeenLastCalledWith({
      seen: freshOrder().map((question) => question.id),
      seed: FRESH_SEED,
    });
  });

  it("starts at the fourth shuffled question when the first three shuffled ids are seen", () => {
    renderQuestions({ seen: freshOrder().slice(0, 3).map((question) => question.id) });

    expect(screen.getByText(freshOrder()[3].text)).toBeTruthy();
    expect(screen.getByText(/^4 of 53/)).toBeTruthy();
  });

  it("starts at index 0 when every bank id is seen", () => {
    renderQuestions({ seen: BANK.map((question) => question.id) });

    expect(screen.getByText(freshOrder()[0].text)).toBeTruthy();
    expect(screen.getByText(/^1 of 53/)).toBeTruthy();
  });

  it("shows Nothing matches with both steps disabled while list 0 remains enabled", () => {
    renderQuestions();
    const { dialog } = openDrawer("options");

    fireEvent.click(within(dialog).getByRole("button", { name: "lighter" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "value" }));

    expect(screen.getByText("Nothing matches.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "prev" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "next" }).hasAttribute("disabled")).toBe(true);
    const listLink = screen
      .getAllByRole("button", { name: "list 0" })
      .find((button) => !button.hasAttribute("aria-pressed"));
    expect(listLink?.hasAttribute("disabled")).toBe(false);
  });

  it("keeps an admitted current question and updates its position when choosing a kind", () => {
    renderQuestions();
    const { dialog } = openDrawer("options");
    const current = freshOrder()[0];
    const kindList = shuffled(
      matches(BANK, { kind: kindOf(current), frame: null, topic: null } satisfies Filters),
      FRESH_SEED,
    );

    fireEvent.click(within(dialog).getByRole("button", { name: String(kindOf(current)) }));

    expect(screen.getByText(current.text)).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`^${kindList.findIndex((question) => question.id === current.id) + 1} of ${kindList.length}`)),
    ).toBeTruthy();
  });

  it("does nothing when the already-selected chip is tapped", () => {
    renderQuestions();
    const { dialog } = openDrawer("options");

    fireEvent.click(within(dialog).getAllByRole("button", { name: "any" })[0]);

    expect(screen.getByText(freshOrder()[0].text)).toBeTruthy();
    expect(settingsMock.storeSettings).not.toHaveBeenCalled();
  });

  it("opens each drawer content from its link and switches segments without closing", () => {
    renderQuestions();
    const options = openDrawer("options");
    expect(options.dialog).toBeTruthy();

    fireEvent.click(within(options.dialog).getByRole("button", { name: `list ${BANK.length}` }));
    expect(screen.getByRole("dialog", { name: "list" })).toBeTruthy();

    fireEvent.click(within(screen.getByRole("dialog", { name: "list" })).getByRole("button", { name: "options" }));
    expect(screen.getByRole("dialog", { name: "options" })).toBeTruthy();

    fireEvent.click(within(screen.getByRole("dialog", { name: "options" })).getByRole("button", { name: "close" }));
    const list = openDrawer("list");
    expect(list.dialog).toBeTruthy();
  });

  it("disables native touch scrolling on the drawer grab area", () => {
    renderQuestions();
    const { dialog } = openDrawer("options");

    expect(dialog.firstElementChild?.classList.contains("touch-none")).toBe(true);
  });

  it("opens the first kind info panel below its control inside the drawer", () => {
    renderQuestions();
    const { dialog } = openDrawer("options");
    const firstKindInfo = within(dialog).getAllByRole("button", { name: "what this does" })[0];

    fireEvent.click(firstKindInfo);

    const panel = within(dialog).getByRole("note");
    expect(panel.classList.contains("top-full")).toBe(true);
    expect(panel.classList.contains("bottom-full")).toBe(false);
  });

  it("selects a list row and closes the drawer", () => {
    renderQuestions();
    openDrawer("list");

    fireEvent.click(rowFor(freshOrder()[1]));

    expect(screen.getByText(freshOrder()[1].text)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks the current question row with aria-current", () => {
    renderQuestions();
    openDrawer("list");

    expect(rowFor(freshOrder()[0]).getAttribute("aria-current")).toBe("true");
  });

  it("closes by Escape, backdrop and close control and returns focus to the opener", () => {
    renderQuestions();

    const escape = openDrawer("options");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(escape.opener);

    const backdrop = openDrawer("options");
    fireEvent.click(backdrop.dialog.parentElement as HTMLDivElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(backdrop.opener);

    const close = openDrawer("options");
    fireEvent.click(within(close.dialog).getByRole("button", { name: "close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(close.opener);
  });

  it("wraps Tab from the last drawer focusable control to the first", () => {
    renderQuestions();
    const { dialog } = openDrawer("options");
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();

    fireEvent.keyDown(dialog, { key: "Tab" });

    expect(document.activeElement).toBe(first);
  });

  it("renders every requested info control and opens a plain line with its mono call", () => {
    renderQuestions();
    openDrawer("options");

    const infoControls = screen.getAllByRole("button", { name: "what this does" });
    expect(infoControls).toHaveLength(12);
    fireEvent.click(infoControls[0]);

    expect(screen.getByText("Admits every question, the lighter ones included; kind no longer narrows the list.")).toBeTruthy();
    expect(screen.getByText("matches(BANK, { ...filters, kind: null })")).toBeTruthy();
  });

  it("uses the stored order without drawing a seed when stored seen ids are non-empty", () => {
    const seed = 1234;
    const order = shuffled(BANK, seed);
    renderQuestions({ seen: [order[0].id], seed }, false);

    expect(screen.getByText(order[1].text)).toBeTruthy();
    expect(settingsMock.storeSettings).not.toHaveBeenCalled();
  });

  it("draws and stores a fresh seed when stored seen ids are empty", () => {
    renderQuestions({ seen: [], seed: 1234 }, false);

    expect(screen.getByText(freshOrder()[0].text)).toBeTruthy();
    expect(settingsMock.storeSettings).toHaveBeenLastCalledWith({ seen: [], seed: FRESH_SEED });
  });

  it("resets seen with a new seed and leaves the current question in place", () => {
    const previousSeed = 1234;
    const previousOrder = shuffled(BANK, previousSeed);
    renderQuestions({ seen: [previousOrder[0].id], seed: previousSeed });
    const { dialog } = openDrawer("options");

    fireEvent.click(within(dialog).getByRole("button", { name: "reset seen" }));

    expect(settingsMock.storeSettings).toHaveBeenLastCalledWith({ seen: [], seed: FRESH_SEED });
    expect(FRESH_SEED).not.toBe(previousSeed);
    expect(screen.getByText(previousOrder[1].text)).toBeTruthy();
  });

  it("walks the same questions in the same order after a reload with a stored seed", () => {
    const seed = 1234;
    const order = shuffled(BANK, seed);
    const first = renderQuestions({ seen: [order[0].id], seed });

    expect(screen.getByText(order[1].text)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "next" }));
    expect(screen.getByText(order[2].text)).toBeTruthy();
    const saved = settingsMock.stored;
    first.unmount();

    renderQuestions(saved, false);

    expect(screen.getByText(order[2].text)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "prev" }));
    expect(screen.getByText(order[1].text)).toBeTruthy();
  });
});
