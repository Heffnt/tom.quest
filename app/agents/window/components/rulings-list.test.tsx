// A message sent in Tom's name sits with his rulings: what went where, when he
// signed it, and no control that would pretend it can be taken back.

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import RulingsList from "./rulings-list";

vi.mock("convex/react", () => ({
  useMutation: () => async () => {},
}));

afterEach(() => cleanup());

const SENT = {
  id: "e1",
  at: 1_756_000_000_000,
  kind: "sent-as-tom",
  key: null,
  todoId: null,
  data: {
    recipient: "Sarah Chen",
    channel: "slack:C0SARAH01",
    sha256: "0123456789abcdef".repeat(4),
    signedAt: 1_755_999_990_000,
  },
};

describe("a sent message in the rulings list", () => {
  it("reads as what went to whom, and opens to his signature and the hash", () => {
    render(<RulingsList rulings={[]} events={[SENT]} />);
    const head = screen.getByText("sent as you to Sarah Chen on Slack C0SARAH01");
    expect(screen.getByText("sent")).toBeTruthy();
    fireEvent.click(head);
    expect(screen.getByText(/^signed by you at /)).toBeTruthy();
    expect(screen.getByText("sha256 0123456789abcdef")).toBeTruthy();
    expect(screen.queryByText("object")).toBeNull();
  });

  it("names a calendar invitation as one", () => {
    render(
      <RulingsList
        rulings={[]}
        events={[{ ...SENT, data: { ...SENT.data, channel: "calendar", recipient: "bob@example.com" } }]}
      />,
    );
    expect(screen.getByText("sent as you to bob@example.com on a calendar invitation")).toBeTruthy();
  });
});
