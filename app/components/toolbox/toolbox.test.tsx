// The toolbox held to vqc/pages.md: the caps hold in code (a rendered count
// beyond a cap cannot happen), every component that shows a number requires
// its caption, and the pages check passes this checkout and fails each rule.

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ isTom: true, canReadSurface: () => true }),
}));
vi.mock("convex/react", () => ({ useQuery: () => undefined }));

import ActionRow from "./action-row";
import AreaFigure from "./area-figure";
import FactTable from "./fact-table";
import FigureStrip from "./figure-strip";
import GroupDrawer from "./group-drawer";
import PageHead from "./page-head";
import Prose from "./prose";
import TimeFigure from "./time-figure";
import { ACTION_CAP, FIGURE_CAP, LIST_CAP } from "./caps";
import { squarify } from "./treemap";
import { checkPageSource, checkToolboxPages } from "@/scripts/check-toolbox-pages.mjs";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("the caps hold", () => {
  it("GroupDrawer shows ten at a time and counts the rest", () => {
    const members = range(25).map((i) => ({ id: `m${i}`, primary: `member ${i}` }));
    const { container } = render(<GroupDrawer title="g" count={40} members={members} caption="q.x → y" />);
    expect(container.querySelectorAll("li")).toHaveLength(LIST_CAP);
    expect(container.textContent).toContain("and 30 more");
    fireEvent.click(screen.getByRole("button", { name: /and 30 more/ }));
    expect(container.querySelectorAll("li")).toHaveLength(LIST_CAP);
    expect(screen.getByText("member 10")).toBeTruthy();
    expect(container.textContent).toContain("and 20 more");
    fireEvent.click(screen.getByRole("button", { name: /and 20 more/ }));
    // Five left in the drawer, fifteen the drawer was never handed.
    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(container.textContent).toContain("and 15 more");
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  it("FactTable renders ten, folds the next ten and counts the rest", () => {
    const rows = range(35).map((i) => ({ name: `row ${i}`, n: i }));
    const { container } = render(
      <FactTable columns={[{ key: "name", name: "name" }, { key: "n", name: "n", align: "num" }]} rows={rows} caption="q.x → y" />,
    );
    const tables = container.querySelectorAll("table");
    expect(tables[0].querySelectorAll("tbody tr")).toHaveLength(LIST_CAP);
    const fold = container.querySelector("details")!;
    expect(fold.open).toBe(false);
    expect(fold.querySelectorAll("tbody tr")).toHaveLength(LIST_CAP);
    expect(fold.textContent).toContain("and 15 more");
    expect(container.querySelectorAll("tbody tr").length).toBeLessThanOrEqual(2 * LIST_CAP);
  });

  it("FigureStrip shows at most six figures", () => {
    const figures = range(9).map((i) => ({ value: i, name: `f${i}` }));
    const { container } = render(<FigureStrip figures={figures} caption="q.x → y" />);
    expect(container.querySelectorAll(".tb-figure")).toHaveLength(FIGURE_CAP);
  });

  it("ActionRow offers at most five actions, each with its call in the popover", () => {
    const actions = range(8).map((i) => ({ label: `a${i}`, call: `mod.fn${i}()`, effect: "does it", onClick: () => {} }));
    render(<ActionRow actions={actions} />);
    const buttons = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-label") !== "what this does");
    expect(buttons).toHaveLength(ACTION_CAP);
    const info = within(buttons[0].parentElement!).getByLabelText("what this does");
    fireEvent.click(info);
    expect(document.querySelector('[role="note"] [class*="font-mono"]')?.textContent).toBe("mod.fn0()");
  });

  it("ActionRow asks for a sentence in a fixed dialog and fires with it", async () => {
    const onClick = vi.fn();
    render(
      <ActionRow
        actions={[
          { label: "revise", call: "ttsRulings.recordRuling()", effect: "sends it back", onClick, ask: { placeholder: "why", required: true }, recommended: true },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "revise" }).className).toContain("is-recommended");
    fireEvent.click(screen.getByRole("button", { name: "revise" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "revise" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByPlaceholderText("why"), { target: { value: "  do it again  " } });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(onClick).toHaveBeenCalledWith("do it again");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a component with numbers requires its caption", () => {
  it("renders the caption as one mono line", () => {
    const { container } = render(
      <>
        <PageHead name="p" sentence="s" caption="c.pageHead → s" />
        <Prose caption="c.prose → s">s</Prose>
        <AreaFigure title="a" cells={[{ key: "k", label: "l", count: 1 }]} caption="c.area → s" />
        <TimeFigure title="t" lanes={[{ name: "n", bins: [1, 2] }]} binLabels={["00:00", "02:00"]} caption="c.time → s" />
        <FigureStrip figures={[{ value: 1, name: "n" }]} caption="c.strip → s" />
        <GroupDrawer title="g" count={1} members={[{ id: "1", primary: "p" }]} caption="c.drawer → s" />
        <FactTable columns={[{ key: "a", name: "a" }]} rows={[{ a: 1 }]} caption="c.table → s" />
      </>,
    );
    const captions = [...container.querySelectorAll(".tb-caption")].map((c) => c.textContent);
    expect(captions).toEqual([
      "c.pageHead → s",
      "c.prose → s",
      "c.area → s",
      "c.time → s",
      "c.strip → s",
      "c.drawer → s",
      "c.table → s",
    ]);
  });

  it("is a type error to leave it out", () => {
    // Each line fails tsc without its @ts-expect-error (CI `tests` runs tsc):
    // a missing caption is a type error, not a runtime omission.
    const missing = [
      // @ts-expect-error caption is required
      <PageHead key="1" name="p" sentence="s" />,
      // @ts-expect-error caption is required
      <Prose key="2">s</Prose>,
      // @ts-expect-error caption is required
      <AreaFigure key="3" title="a" cells={[]} />,
      // @ts-expect-error caption is required
      <TimeFigure key="4" title="t" lanes={[]} binLabels={[]} />,
      // @ts-expect-error caption is required
      <FigureStrip key="5" figures={[]} />,
      // @ts-expect-error caption is required
      <GroupDrawer key="6" title="g" count={0} members={[]} />,
      // @ts-expect-error caption is required
      <FactTable key="7" columns={[]} rows={[]} />,
    ];
    expect(missing).toHaveLength(7);
  });
});

describe("AreaFigure", () => {
  it("outlines the selected cell, tints its group and hides what does not fit", () => {
    const cells = [
      { key: "a|x", label: "x", count: 50, group: "a" },
      { key: "a|y", label: "y", count: 30, group: "a" },
      { key: "b|x", label: "x", count: 19, group: "b" },
      { key: "b|tiny", label: "a label far too long for its rectangle", count: 1, group: "b" },
    ];
    const onSelect = vi.fn();
    const { container } = render(
      <AreaFigure title="t" cells={cells} selectedKey="a|y" onSelect={onSelect} caption="q.x → y" />,
    );
    const cell = (key: string) => container.querySelector(`[aria-label^="${key}"]`)!;
    expect(container.querySelector(".is-selected")?.getAttribute("aria-label")).toBe("y 30");
    expect(container.querySelectorAll(".is-group")).toHaveLength(2);
    expect(container.textContent).not.toContain("a label far too long");
    fireEvent.click(cell("x 19"));
    expect(onSelect).toHaveBeenCalledWith("b|x");
  });
});

describe("squarify", () => {
  it("fills the box with areas proportional to the counts", () => {
    const placed = squarify(
      [{ count: 6 }, { count: 6 }, { count: 4 }, { count: 3 }, { count: 2 }, { count: 2 }, { count: 1 }, { count: 0 }],
      { x: 0, y: 0, w: 600, h: 400 },
    );
    expect(placed).toHaveLength(7);
    const total = placed.reduce((a, r) => a + r.w * r.h, 0);
    expect(total).toBeCloseTo(600 * 400, 3);
    for (const r of placed) {
      expect(r.w * r.h).toBeCloseTo((r.count / 24) * 600 * 400, 3);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(400 + 1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(600 + 1e-9);
    }
  });
});

describe("the pages check", () => {
  it("passes app/toolbox and the toolbox in this checkout", () => {
    expect(checkToolboxPages(ROOT)).toEqual({ code: 0, errors: [] });
  });

  it("fails a page that breaks each rule", () => {
    const page = `
import Info from "@/app/tts/components/info";
function Card() { return <div className="p-2" style={{ color: "#fff" }}>readiness</div>; }
export default function P() { return <Card />; }
`;
    const errors = checkPageSource("app/p/page.tsx", page).join("\n");
    for (const rule of ['imports "@/app/tts/components/info"', "defines the component Card", "className attribute", "style attribute", "colour literal", '"readiness"']) {
      expect(errors).toContain(rule);
    }
  });
});
