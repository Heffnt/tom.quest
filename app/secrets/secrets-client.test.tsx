// tom.quest/secrets: the gate and the form. The real TomGate renders here
// with a stand-in auth, so the three viewers that matter are each rendered:
// Tom sees the paste area and the names; anyone else, the agent account included,
// sees the restricted card and never asks Convex for the list.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SecretsClient from "./secrets-client";

const state = vi.hoisted(() => ({
  auth: { isTom: true, isAgent: false, loading: false },
  rows: [] as unknown,
  listArgs: [] as unknown[],
  calls: [] as { name: string; args: unknown }[],
  refuse: null as string | null,
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useQuery: (ref: unknown, args: unknown) => {
      state.listArgs.push(args);
      return args === "skip" ? undefined : name(ref as never) === "secrets:list" ? state.rows : undefined;
    },
    useMutation: (ref: unknown) => async (args: { name: string }) => {
      state.calls.push({ name: name(ref as never), args });
      if (args.name === state.refuse) {
        throw new Error(`[CONVEX M(secrets:set)] Uncaught Error: ${args.name}: value is empty\n    at handler`);
      }
    },
  };
});

// app/lib/auth pulls in Sentry, which does not load under jsdom. The stand-in
// keeps the real rule: only Tom reads a surface outside agentSurfaces.ts.
vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({
    ...state.auth,
    canReadSurface: (label: string) => state.auth.isTom || (state.auth.isAgent && ["TTS", "Turing"].includes(label)),
  }),
}));

afterEach(() => {
  cleanup();
  state.rows = [];
  state.listArgs = [];
  state.calls = [];
  state.refuse = null;
});

describe("the gate", () => {
  it.each([
    ["a signed-in user", { isTom: false, isAgent: false, loading: false }],
    ["the agent account", { isTom: false, isAgent: true, loading: false }],
  ])("shows %s the restricted card and never reads the list", (_who, auth) => {
    state.auth = auth;
    render(<SecretsClient />);
    expect(screen.getByText("Secrets access is restricted to Tom.")).toBeTruthy();
    expect(screen.queryByLabelText("paste")).toBeNull();
    expect(state.listArgs.every((args) => args === "skip")).toBe(true);
  });
});

describe("for Tom", () => {
  it("lists each name with its dates and the value's length", () => {
    state.auth = { isTom: true, isAgent: false, loading: false };
    state.rows = [
      {
        name: "HF_TOKEN",
        setAt: Date.parse("2026-09-24T12:00:00Z"),
        length: 37,
        takenAt: Date.parse("2026-09-24T12:00:30Z"),
      },
      { name: "WANDB_API_KEY", setAt: Date.parse("2026-09-24T13:00:00Z"), length: 40 },
      { name: "OLD_ROW", setAt: Date.parse("2026-09-20T13:00:00Z"), takenAt: Date.parse("2026-09-20T13:00:20Z") },
    ];
    render(<SecretsClient />);
    expect(screen.getByText("HF_TOKEN")).toBeTruthy();
    expect(screen.getByText("WANDB_API_KEY")).toBeTruthy();
    expect(screen.getAllByText(/^set /)).toHaveLength(3);
    expect(screen.getAllByText(/^taken /)).toHaveLength(2);
    expect(screen.getByText("waiting for the box")).toBeTruthy();
    expect(screen.getByText("37 characters")).toBeTruthy();
    expect(screen.getByText("40 characters")).toBeTruthy();
    // A row from before lengths were kept shows none.
    expect(screen.getAllByText(/characters$/)).toHaveLength(2);
  });

  it("shows the paste in clear and sends one value per line", async () => {
    state.auth = { isTom: true, isAgent: false, loading: false };
    render(<SecretsClient />);
    const paste = screen.getByLabelText("paste") as HTMLTextAreaElement;
    expect(paste.tagName).toBe("TEXTAREA");
    expect(paste.getAttribute("type")).toBeNull();
    fireEvent.change(paste, { target: { value: "# from notes\nexport HF_TOKEN=\"hf_live\"\n\nWANDB_API_KEY = wb=1#2\n" } });
    expect(paste.value).toContain("hf_live");
    fireEvent.click(screen.getByText("Send to the box"));
    await waitFor(() => expect(state.calls).toHaveLength(2));
    expect(state.calls).toEqual([
      { name: "secrets:set", args: { name: "HF_TOKEN", value: "hf_live" } },
      { name: "secrets:set", args: { name: "WANDB_API_KEY", value: "wb=1#2" } },
    ]);
    await waitFor(() => expect(paste.value).toBe(""));
    expect(screen.getByText("sent HF_TOKEN, WANDB_API_KEY")).toBeTruthy();
  });

  it("lists refused lines without their values and leaves only those lines to fix", async () => {
    state.auth = { isTom: true, isAgent: false, loading: false };
    state.refuse = "BLANKISH";
    render(<SecretsClient />);
    const paste = screen.getByLabelText("paste") as HTMLTextAreaElement;
    fireEvent.change(paste, {
      target: { value: "GOOD=ok-value\nbad-name=secret-one\nBLANKISH=secret-two\nDUP=first\nDUP=second" },
    });
    fireEvent.click(screen.getByText("Send to the box"));
    await waitFor(() => expect(screen.getByText("sent GOOD, DUP")).toBeTruthy());
    expect(screen.getByText(/^line 2: name must be/)).toBeTruthy();
    expect(screen.getByText("line 3 (BLANKISH): BLANKISH: value is empty")).toBeTruthy();
    expect(screen.getByText("line 4 (DUP): repeated on line 5, which is sent")).toBeTruthy();
    expect(screen.getByRole("status").textContent).not.toMatch(/secret-one|secret-two/);
    expect(paste.value).toBe("bad-name=secret-one\nBLANKISH=secret-two");
  });
});
