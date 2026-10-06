// The design page: the counts, the legend, the drawings and the list drawn
// from the page query's answer; a box or a hash opens a part's panel; the
// panel's sections in order, an empty one left out; ?head= draws the
// registry diff.
// "This is right" calls design.confirm.
// The sentence field calls design.rule, and a panel opened for another part
// starts with an empty field.

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { USE_STATES } from "@/shared/parts-drawing.mjs";
import type { RegistryRow } from "@/convex/jarvis/design";
import type { PartAnswer } from "./components/part-panel";

const REGISTRY: RegistryRow[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "parts.json"), "utf8"));
const NOW = 1_800_000_000_000;

const PAGE = {
  registry: { id: "e1", subject: "Jarvis@8aca30b4da86", sha: "8aca30b4da86", at: NOW, parts: REGISTRY },
  states: Object.fromEntries(REGISTRY.map((row, i) => [row.id, USE_STATES[i % USE_STATES.length]])),
  counts: { parts: 93, unverified: 19, issue: 18, partial: 0, removedStillRun: 16, noSentence: 17 },
};

const threadPage = REGISTRY.find((row) => row.id === "thread-page")!;
const PART: PartAnswer = {
  registry: { subject: "Jarvis@8aca30b4da86", sha: "8aca30b4da86", at: NOW },
  row: threadPage,
  names: Object.fromEntries(REGISTRY.map((row) => [row.id, row.name])),
  serves: [
    { form: "evidence", ref: "intent.md#Fixture entries#a line", file: "intent.md", line: "a line", said: [{ date: "2026-10-04", source: "session", sentence: "the fixture sentence" }] },
    { form: "evidence", ref: "writing.md#Pages#a page", file: "writing.md", line: null, said: [] },
    { form: "guarantee", label: "G4", line: "the fixture guarantee line." },
  ],
  state: { state: "in use", partial: false, row: { id: "u1", kind: "use", at: NOW - 60_000, text: "read the thread", agentId: null }, inUseDays: 30, workingAfterDays: 7 },
  rulings: [],
  measures: { windowDays: 30, lastUse: { at: NOW - 60_000, what: "read the thread", by: "tom" } },
  explanation: null,
  cuts: [],
} as PartAnswer;

const DIFF = {
  head: "Jarvis@1234567",
  registryDiff: {
    base: "8aca30b4da86",
    added: [],
    changed: ["deploy"],
    removed: ["sweep"],
    rows: { deploy: { ...REGISTRY.find((row) => row.id === "deploy")!, note: "changed" } },
  },
  base: PAGE.registry,
  baseIsExact: true,
};

let answers: Record<string, unknown> = {};
const calls: { name: string; args: unknown }[] = [];
let search = new URLSearchParams();

vi.mock("next/navigation", () => ({ useSearchParams: () => search }));
vi.mock("convex/react", () => ({
  useQuery: (fn: unknown, args: unknown) => (args === "skip" ? undefined : answers[getFunctionName(fn as never)]),
  useMutation: (fn: unknown) => async (args: unknown) => {
    calls.push({ name: getFunctionName(fn as never), args });
    return null;
  },
}));
vi.mock("@/app/lib/auth", () => ({ useAuth: () => ({ isTom: true }) }));
vi.mock("@/app/components/tom-gate", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import DesignClient from "./design-client";
import { useDesignStore } from "./store";

beforeEach(() => {
  answers = { "jarvis/design:page": PAGE, "jarvis/design:part": PART, "jarvis/design:diff": DIFF };
  calls.length = 0;
  search = new URLSearchParams();
  window.history.replaceState(null, "", "/design");
  useDesignStore.setState({ filter: "all", selected: null });
});

afterEach(() => cleanup());

describe("the design page", () => {
  it("draws the counts, the legend, seven drawings and the list", () => {
    const { container } = render(<DesignClient />);
    expect(screen.getByText("landed, never run")).toBeTruthy();
    expect(screen.getByText("ruled removed, still run")).toBeTruthy();
    const titles = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(titles).toEqual([
      "Legend",
      "Every running part",
      "What you design in session, and what outcomes govern",
      "The fate of each part in 2.0",
      "Who starts whom",
      "The record's routes",
      "The tools",
      "Every part",
    ]);
    expect(container.querySelectorAll("svg")).toHaveLength(7);
    const list = container.querySelectorAll("li button");
    expect(list).toHaveLength(93);
  });

  it("filters the list by a count", () => {
    const { container } = render(<DesignClient />);
    fireEvent.click(screen.getByText("with an issue"));
    const issues = Object.values(PAGE.states).filter((s) => s === "issue").length;
    expect(container.querySelectorAll("li button")).toHaveLength(issues);
  });

  it("opens a part's panel from its box and names it in the hash", () => {
    const { container } = render(<DesignClient />);
    fireEvent.click(container.querySelector("#part-thread-page")!);
    expect(window.location.hash).toBe("#thread-page");
    expect(screen.getByRole("heading", { level: 2, name: "/thread" })).toBeTruthy();
    fireEvent.click(screen.getByText("close"));
    expect(window.location.hash).toBe("");
    expect(useDesignStore.getState().selected).toBeNull();
  });

  it("opens the panel a hash names on arrival", () => {
    window.history.replaceState(null, "", "/design#thread-page");
    render(<DesignClient />);
    expect(useDesignStore.getState().selected).toBe("thread-page");
    expect(screen.getByRole("heading", { level: 2, name: "/thread" })).toBeTruthy();
  });

  it("shows a state the byte budget cut as partial, in the counts and the list", () => {
    const capped = REGISTRY[0].id;
    answers["jarvis/design:page"] = { ...PAGE, states: { ...PAGE.states, [capped]: "partial" }, counts: { ...PAGE.counts, partial: 1 } };
    const { container } = render(<DesignClient />);
    fireEvent.click(screen.getByText("state partial"));
    const rows = [...container.querySelectorAll("li button")].map((b) => b.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("partial");
  });

  it("shows the panel's sections in order and leaves an empty one out", () => {
    window.history.replaceState(null, "", "/design#thread-page");
    const { container } = render(<DesignClient />);
    const aside = container.querySelector("aside")!;
    const sections = [...aside.querySelectorAll("h3")].map((h) => h.textContent);
    expect(sections).toEqual(["the row", "its sentences", "its state", "its measures (30 days, agent-set)", "your sentences"]);
    expect(aside.textContent).toContain("“the fixture sentence”");
    expect(aside.textContent).toContain("writing.md#Pages#a page (not in the record)");
    expect(aside.textContent).toContain("governed by outcomes (agent-set)");
  });

  it("sends 'this is right' through design.confirm", async () => {
    answers["jarvis/design:part"] = {
      ...PART,
      explanation: { id: "x1", at: NOW, title: "What /thread is", html: "<!doctype html><p>x</p>", agentId: null, session: "s1", confirmedAt: null },
    };
    window.history.replaceState(null, "", "/design#thread-page");
    render(<DesignClient />);
    await act(async () => {
      fireEvent.click(screen.getByText("this is right"));
    });
    expect(calls).toEqual([{ name: "jarvis/design:confirm", args: { part: "thread-page", explanationId: "x1" } }]);
  });

  it("sends his sentence through design.rule", async () => {
    window.history.replaceState(null, "", "/design#thread-page");
    render(<DesignClient />);
    fireEvent.change(screen.getByPlaceholderText("What working well means for /thread"), { target: { value: "it shows every row" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Send"));
    });
    expect(calls).toEqual([{ name: "jarvis/design:rule", args: { part: "thread-page", sentence: "it shows every row" } }]);
  });

  it("starts the sentence field empty when a related part's panel opens, so his text cannot go to another part", () => {
    window.history.replaceState(null, "", "/design#thread-page");
    render(<DesignClient />);
    const field = screen.getByPlaceholderText("What working well means for /thread") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "meant for /thread" } });
    // /thread reads the record; its link opens the record's panel.
    fireEvent.click(screen.getAllByText(PART.names.record)[0]);
    expect(useDesignStore.getState().selected).toBe("record");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
  });

  it("says there is no registry, and draws nothing, before the box posts one", () => {
    answers["jarvis/design:page"] = { registry: null };
    const { container } = render(<DesignClient />);
    expect(screen.getByText("no registry in the record")).toBeTruthy();
    expect(container.querySelectorAll("svg")).toHaveLength(0);
  });
});

describe("the diff view", () => {
  it("draws a head's diff in the fate styles, with its counts in the caption", () => {
    search = new URLSearchParams("head=Jarvis@1234567");
    const { container } = render(<DesignClient />);
    expect(screen.getByText("0 added, 1 changed, 1 removed against 8aca30b, from the tests row of Jarvis@1234567.")).toBeTruthy();
    const svg = container.querySelector("svg")!;
    // The changed row is amber and dashed, the removed one struck.
    const deploy = svg.querySelector("#part-deploy")!;
    expect(deploy.querySelector("rect")!.getAttribute("style")).toContain("var(--replaced)");
    expect(deploy.textContent).toContain("changed");
    expect(svg.querySelector("#part-sweep")!.textContent).toContain("removed");
    expect([...container.querySelectorAll("li button")].map((b) => b.textContent)).toEqual([
      "deploy · changed · worker/jobs/deploy.mjs",
      "sweep · removed · worker/agents/sweep.mjs",
    ]);
  });

  it("says there is no diff for a head with no tests row", () => {
    answers["jarvis/design:diff"] = null;
    search = new URLSearchParams("head=Jarvis@nothing");
    render(<DesignClient />);
    expect(screen.getByText("no registry diff for Jarvis@nothing")).toBeTruthy();
  });
});
