import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BANK } from "./data/types";
import QuestionsClient from "./questions-client";
import { matches, type Filters } from "./lib/pick";

const settingsMock = vi.hoisted(() => ({
  seen: [] as string[],
  storeSettings: vi.fn(),
}));

vi.mock("@/app/lib/hooks/use-persisted-settings", () => ({
  usePersistedSettings: () => [{ seen: settingsMock.seen }, settingsMock.storeSettings, true],
}));

vi.mock("@/app/components/tom-gate", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

function renderQuestions(seen: string[] = []) {
  settingsMock.seen = seen;
  settingsMock.storeSettings.mockReset();
  return render(<QuestionsClient />);
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

afterEach(cleanup);

beforeEach(() => {
  settingsMock.seen = [];
  settingsMock.storeSettings.mockReset();
});

describe("QuestionsClient", () => {
  it("shows the first bank question with prev disabled, next enabled, and 1 of 53 on a fresh load", () => {
    renderQuestions();

    expect(screen.getByText(BANK[0].text)).toBeTruthy();
    expect(screen.getByRole("button", { name: "prev" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "next" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/^1 of 53/)).toBeTruthy();
  });

  it("moves next to the second question, enables prev, and stores the left id", () => {
    renderQuestions();

    fireEvent.click(screen.getByRole("button", { name: "next" }));

    expect(screen.getByText(BANK[1].text)).toBeTruthy();
    expect(screen.getByRole("button", { name: "prev" }).hasAttribute("disabled")).toBe(false);
    expect(settingsMock.storeSettings).toHaveBeenLastCalledWith({ seen: [BANK[0].id] });
  });

  it("moves prev without making another settings write", () => {
    renderQuestions();
    fireEvent.click(screen.getByRole("button", { name: "next" }));
    const writesAfterNext = settingsMock.storeSettings.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "prev" }));

    expect(screen.getByText(BANK[0].text)).toBeTruthy();
    expect(settingsMock.storeSettings.mock.calls).toHaveLength(writesAfterNext);
  });

  it("keeps next rendered and disabled at the last index", () => {
    renderQuestions();

    for (let index = 1; index < BANK.length; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "next" }));
    }

    const next = screen.getByRole("button", { name: "next" });
    expect(screen.getByText(BANK.at(-1)?.text ?? "")).toBeTruthy();
    expect(next).toBeTruthy();
    expect(next.hasAttribute("disabled")).toBe(true);
  });

  it("starts at the fourth question when the first three ids are seen", () => {
    renderQuestions(BANK.slice(0, 3).map((question) => question.id));

    expect(screen.getByText(BANK[3].text)).toBeTruthy();
    expect(screen.getByText(/^4 of 53/)).toBeTruthy();
  });

  it("starts at index 0 when every bank id is seen", () => {
    renderQuestions(BANK.map((question) => question.id));

    expect(screen.getByText(BANK[0].text)).toBeTruthy();
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
    const kindOneList = matches(BANK, { kind: 1, frame: null, topic: null } satisfies Filters);

    fireEvent.click(within(dialog).getByRole("button", { name: "1" }));

    expect(screen.getByText(BANK[0].text)).toBeTruthy();
    expect(screen.getByText(new RegExp(`^${kindOneList.findIndex((question) => question.id === BANK[0].id) + 1} of ${kindOneList.length}`))).toBeTruthy();
  });

  it("does nothing when the already-selected chip is tapped", () => {
    renderQuestions();
    const { dialog } = openDrawer("options");

    fireEvent.click(within(dialog).getAllByRole("button", { name: "any" })[0]);

    expect(screen.getByText(BANK[0].text)).toBeTruthy();
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

  it("selects a list row and closes the drawer", () => {
    renderQuestions();
    openDrawer("list");

    fireEvent.click(rowFor(BANK[1]));

    expect(screen.getByText(BANK[1].text)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks the current question row with aria-current", () => {
    renderQuestions();
    openDrawer("list");

    expect(rowFor(BANK[0]).getAttribute("aria-current")).toBe("true");
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

  it("resets seen in settings and leaves the current question in place", () => {
    renderQuestions();
    fireEvent.click(screen.getByRole("button", { name: "next" }));
    const { dialog } = openDrawer("options");

    fireEvent.click(within(dialog).getByRole("button", { name: "reset seen" }));

    expect(settingsMock.storeSettings).toHaveBeenLastCalledWith({ seen: [] });
    expect(screen.getByText(BANK[1].text)).toBeTruthy();
  });
});
