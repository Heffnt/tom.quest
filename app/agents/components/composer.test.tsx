// The message box writes the row the session host picks up: Send calls
// claudeSessions.sendMessage, which queues a claudeInbound row the host claims
// on its next poll. The sessions page also hands it the model and login
// selectors, which it draws in its control row.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useMutation: (ref: unknown) => async (args: unknown) => {
      calls.push(`${name(ref as never)}:${JSON.stringify(args)}`);
    },
  };
});

import Composer from "./composer";

const session = {
  _id: "k17abcdefghijklmnopqrstu",
  status: "idle",
} as never;

afterEach(() => {
  cleanup();
  calls.length = 0;
});

describe("Composer", () => {
  it("sends the typed message to claudeSessions.sendMessage", async () => {
    render(<Composer session={session} daemonStale={false} />);
    fireEvent.change(screen.getByPlaceholderText("message the session"), {
      target: { value: "hello from the page" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await vi.waitFor(() =>
      expect(calls).toEqual([
        `claudeSessions:sendMessage:${JSON.stringify({ sessionId: "k17abcdefghijklmnopqrstu", text: "hello from the page" })}`,
      ]),
    );
  });

  it("draws the controls it is handed on a live session and on an ended one", () => {
    const { rerender } = render(
      <Composer session={session} daemonStale={false} controls={<span>the selectors</span>} />,
    );
    expect(screen.getByText("the selectors")).toBeTruthy();
    rerender(
      <Composer
        session={{ _id: "k17abcdefghijklmnopqrstu", status: "ended" } as never}
        daemonStale={false}
        controls={<span>the selectors</span>}
      />,
    );
    expect(screen.getByText("the selectors")).toBeTruthy();
  });
});
