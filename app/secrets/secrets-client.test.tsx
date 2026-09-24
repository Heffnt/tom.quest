// tom.quest/secrets: the gate and the form. The real TomGate renders here
// with a stand-in auth, so the three viewers that matter are each rendered:
// Tom sees the form and the names; anyone else, the agent account included,
// sees the restricted card and never asks Convex for the list.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SecretsClient from "./secrets-client";

const state = vi.hoisted(() => ({
  auth: { isTom: true, isAgent: false, loading: false },
  rows: [] as unknown,
  listArgs: [] as unknown[],
  calls: [] as { name: string; args: unknown }[],
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useQuery: (ref: unknown, args: unknown) => {
      state.listArgs.push(args);
      return args === "skip" ? undefined : name(ref as never) === "secrets:list" ? state.rows : undefined;
    },
    useMutation: (ref: unknown) => async (args: unknown) => {
      state.calls.push({ name: name(ref as never), args });
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
});

describe("the gate", () => {
  it.each([
    ["a signed-in user", { isTom: false, isAgent: false, loading: false }],
    ["the agent account", { isTom: false, isAgent: true, loading: false }],
  ])("shows %s the restricted card and never reads the list", (_who, auth) => {
    state.auth = auth;
    render(<SecretsClient />);
    expect(screen.getByText("Secrets access is restricted to Tom.")).toBeTruthy();
    expect(screen.queryByLabelText("value")).toBeNull();
    expect(state.listArgs.every((args) => args === "skip")).toBe(true);
  });
});

describe("for Tom", () => {
  it("lists each name with its dates", () => {
    state.auth = { isTom: true, isAgent: false, loading: false };
    state.rows = [
      { name: "HF_TOKEN", setAt: Date.parse("2026-09-24T12:00:00Z"), takenAt: Date.parse("2026-09-24T12:00:30Z") },
      { name: "WANDB_API_KEY", setAt: Date.parse("2026-09-24T13:00:00Z") },
    ];
    render(<SecretsClient />);
    expect(screen.getByText("HF_TOKEN")).toBeTruthy();
    expect(screen.getByText("WANDB_API_KEY")).toBeTruthy();
    expect(screen.getAllByText(/^set /)).toHaveLength(2);
    expect(screen.getByText(/^taken /)).toBeTruthy();
    expect(screen.getByText("waiting for the box")).toBeTruthy();
  });

  it("sends the name and value, then clears both fields", async () => {
    state.auth = { isTom: true, isAgent: false, loading: false };
    render(<SecretsClient />);
    const name = screen.getByLabelText("name") as HTMLInputElement;
    const value = screen.getByLabelText("value") as HTMLInputElement;
    expect(value.type).toBe("password");
    fireEvent.change(name, { target: { value: "hf_token" } });
    fireEvent.change(value, { target: { value: "hf_live_value" } });
    fireEvent.click(screen.getByText("Send to the box"));
    await waitFor(() => expect(state.calls).toHaveLength(1));
    expect(state.calls[0]).toEqual({ name: "secrets:set", args: { name: "HF_TOKEN", value: "hf_live_value" } });
    await waitFor(() => expect(value.value).toBe(""));
    expect(name.value).toBe("");
  });
});
