// The sign-off control on the everything tab: the verbatim text beside the
// control that signs it, two presses to sign, and nothing for anyone but Tom.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { api } from "@/convex/_generated/api";
import SignoffBlock from "./signoff-block";

const convex = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  isTom: true,
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useQuery: (ref: unknown, args: unknown) =>
      args === "skip" ? undefined : convex.data[name(ref as never)],
    useMutation: (ref: unknown) => async (args: unknown) => {
      convex.calls.push({ name: name(ref as never), args });
    },
  };
});

// app/lib/auth pulls in Sentry, which does not load under jsdom.
vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ isTom: convex.isTom, canReadSurface: () => true }),
}));

const NOW = 1_756_000_000_000;
const TEXT = "Hi Sarah — Thursday at 3 works for the lab meeting.\nSee you then.";
const PROPOSAL = {
  id: "p1",
  at: NOW - 5 * 60_000,
  text: TEXT,
  recipient: "Sarah Chen",
  channel: "slack:C0SARAH01",
  agentId: "claude:box:abcdef0123456789",
  why: "she asked for a time",
  status: "proposed",
  error: null,
};

beforeEach(() => {
  cleanup();
  convex.calls.length = 0;
  convex.isTom = true;
  convex.data = { [getFunctionName(api.ttsSignoff.listProposals)]: [PROPOSAL] };
});

describe("SignoffBlock", () => {
  it("shows the text verbatim with its recipient and channel", () => {
    render(<SignoffBlock now={NOW} />);
    expect(screen.getByText((_, el) => el?.tagName === "PRE" && el.textContent === TEXT)).toBeTruthy();
    expect(screen.getByText("Sarah Chen")).toBeTruthy();
    expect(screen.getByText(/Slack C0SARAH01/)).toBeTruthy();
    expect(screen.getByText("the agent").getAttribute("href")).toBe(
      `/agents?agent=${encodeURIComponent(PROPOSAL.agentId)}`,
    );
  });

  it("signs on the second press only", async () => {
    render(<SignoffBlock now={NOW} />);
    fireEvent.click(screen.getByText("sign and send"));
    expect(convex.calls).toEqual([]);
    fireEvent.click(screen.getByText("press again to send"));
    await vi.waitFor(() =>
      expect(convex.calls).toEqual([{ name: getFunctionName(api.ttsSignoff.signAndSend), args: { proposalId: "p1" } }]),
    );
  });

  it("disarms when the control loses focus", () => {
    render(<SignoffBlock now={NOW} />);
    fireEvent.click(screen.getByText("sign and send"));
    fireEvent.blur(screen.getByText("press again to send"));
    expect(screen.getByText("sign and send")).toBeTruthy();
  });

  it("shows no control while a signed message is on its way", () => {
    convex.data = { [getFunctionName(api.ttsSignoff.listProposals)]: [{ ...PROPOSAL, status: "sending" }] };
    render(<SignoffBlock now={NOW} />);
    expect(screen.queryByText("sign and send")).toBeNull();
    expect(screen.getByText("signed · sending")).toBeTruthy();
  });

  it("renders nothing for anyone but Tom, and nothing when none waits", () => {
    convex.isTom = false;
    const { container } = render(<SignoffBlock now={NOW} />);
    expect(container.innerHTML).toBe("");
    cleanup();
    convex.isTom = true;
    convex.data = { [getFunctionName(api.ttsSignoff.listProposals)]: [] };
    const empty = render(<SignoffBlock now={NOW} />);
    expect(empty.container.innerHTML).toBe("");
  });
});
