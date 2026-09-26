// The approve control says what merges a change: the merge gate's two
// checks, the tests and the audit (the evals arm left the gate on
// 2026-09-26).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { api } from "@/convex/_generated/api";
import ChangesList from "./changes-list";

const WAITING = {
  id: "pr-1",
  repo: "tom.quest",
  number: 7,
  title: "A change waiting on the gate",
  branch: "night/x",
  draft: false,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  checks: [],
  ruled: null,
  allowed: false,
  lastAttempt: null,
};

vi.mock("convex/react", () => ({
  useQuery: (fn: unknown) => (getFunctionName(fn as never) === getFunctionName(api.observe.changesWaiting) ? [WAITING] : undefined),
  useMutation: () => async () => {},
}));

afterEach(() => cleanup());

describe("the approve control's explanation", () => {
  it("names the tests and the audit, and no third gate row", () => {
    render(<ChangesList events={[]} runs={[]} now={1_756_000_000_000} />);
    fireEvent.click(screen.getAllByLabelText("what this does")[0]);
    const text = screen.getByText(/Records your ruling approving this change/).textContent ?? "";
    expect(text).toContain("its tests are green and its audit approved it");
    expect(text).not.toContain("three");
  });
});
