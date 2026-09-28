import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const state = vi.hoisted(() => ({
  entries: [] as unknown,
  series: { measurements: [], runs: [] } as unknown,
  training: {
    cells: [{ column: "Block", text: "Current block" }],
    notes: [],
    ideas: [{ label: "Option", text: "Current idea" }],
  } as unknown,
  submit: vi.fn(),
}));

vi.mock("@/convex/_generated/api", () => ({
  api: { dayLog: { page: "page", series: "series", trainingDay: "training-day", submit: "submit" } },
}));

vi.mock("convex/react", () => ({
  useQuery: (reference: string) => {
    if (reference === "page") return state.entries;
    if (reference === "series") return state.series;
    if (reference === "training-day") return state.training;
    return undefined;
  },
  useMutation: () => state.submit,
}));

vi.mock("@/app/lib/auth", () => ({ useAuth: () => ({ isTom: true }) }));
vi.mock("@/app/components/tom-gate", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/app/jarvis/components/info", () => ({ default: () => <span>info</span> }));
vi.mock("@/app/jarvis/lib", () => ({ errMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));

import LogClient from "./log-client";

afterEach(() => {
  cleanup();
  state.entries = [];
  state.series = { measurements: [], runs: [] };
  state.training = {
    cells: [{ column: "Block", text: "Current block" }],
    notes: [],
    ideas: [{ label: "Option", text: "Current idea" }],
  };
  state.submit.mockReset();
});

describe("LogClient", () => {
  it("disables an over-limit entry, shows its count, and reserves a plain error line", async () => {
    state.submit.mockRejectedValueOnce(new Error("The entry could not be saved."));
    render(<LogClient />);

    const entry = screen.getByLabelText("Entry");
    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    const errorLine = document.querySelector("p[aria-live='polite']");
    expect(errorLine).toBeTruthy();
    expect(errorLine?.className).toContain("min-h-5");

    fireEvent.change(entry, { target: { value: "x".repeat(4_012) } });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("4,012 of 4,000 characters")).toBeTruthy();

    fireEvent.change(entry, { target: { value: "A short entry" } });
    expect(screen.queryByText("4,012 of 4,000 characters")).toBeNull();
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText("The entry could not be saved.")).toBeTruthy());
  });

  it("opens ideas in a fixed dialog and closes it from Escape or Close", () => {
    render(<LogClient />);

    fireEvent.click(screen.getByRole("button", { name: "Ideas" }));
    const dialog = screen.getByRole("dialog", { name: "Ideas" });
    expect(dialog.className).toContain("fixed");
    expect(within(dialog).getByText(/Current idea/)).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Ideas" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ideas" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Ideas" })).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Ideas" })).toBeNull();
  });
});
