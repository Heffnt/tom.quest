import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { HistoryPage } from "@/convex/historyRows";
import { newYorkInstant } from "@/shared/clock.mjs";
import HistoryView from "./history-view";

const DAYS = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];
const RANGE = { from: DAYS[0]!, to: DAYS.at(-1)! };
const at = (day: string, hour: number) => newYorkInstant(day, hour);

function empty(): HistoryPage {
  return { from: RANGE.from, to: RANGE.to, days: DAYS, weights: [], meals: [], trainings: [], told: [], actions: [], cuts: [] };
}

function fixture(): HistoryPage {
  return {
    ...empty(),
    weights: [
      { id: "w1", at: at("2026-10-01", 7), day: "2026-10-01", lb: 182 },
      { id: "w2", at: at("2026-10-03", 7), day: "2026-10-03", lb: 181.2 },
      { id: "w3", at: at("2026-10-06", 7), day: "2026-10-06", lb: 180.4 },
    ],
    meals: [
      { id: "m1", at: at("2026-10-02", 12), day: "2026-10-02", text: "chicken and rice", proteinG: 45, calories: 650 },
      { id: "m2", at: at("2026-10-02", 19), day: "2026-10-02", text: "pasta" },
      { id: "m3", at: at("2026-10-05", 8), day: "2026-10-05", text: "oatmeal", proteinG: 12 },
    ],
    trainings: [
      { id: "t1", at: at("2026-10-03", 18), day: "2026-10-03", text: "hangboard", bodyParts: ["fingers", "forearms"], durationMin: 40 },
      { id: "t2", at: at("2026-10-06", 18), day: "2026-10-06", text: "ran 3 miles", activity: "run", bodyParts: [], distanceMi: 3 },
    ],
    told: [
      { id: "s1", at: at("2026-10-03", 21), day: "2026-10-03", text: "hangboarded forty minutes and ate pasta" },
    ],
    actions: [
      { id: "a1", at: at("2026-10-05", 15), day: "2026-10-05", kind: "merge", text: "Landed in Jarvis (#220): scripts: the laptop mirrors sessions", href: "https://github.com/Heffnt/Jarvis/pull/220" },
      { id: "a2", at: at("2026-10-05", 16), day: "2026-10-05", kind: "decision", text: "Decided: hold all seven", href: null },
    ],
  };
}

afterEach(cleanup);

describe("HistoryView", () => {
  it("draws the charts, the day strip and a column per day from one read", () => {
    const { container } = render(<HistoryView data={fixture()} range={RANGE} today={RANGE.to} onRange={() => {}} />);

    const charts = screen.getByRole("region", { name: "Diet and exercise" });
    const weight = within(charts).getByRole("region", { name: "Weight over time" });
    expect(weight.querySelectorAll("circle")).toHaveLength(3);
    expect(weight.querySelector("path")).not.toBeNull();
    expect(within(weight).getByText(/180\.4 lb/)).toBeTruthy();

    const training = within(charts).getByRole("region", { name: "Training per week by body part" });
    const segments = [...training.querySelectorAll("rect[data-part]")].map((rect) => [rect.getAttribute("data-part"), rect.getAttribute("data-sessions")]);
    // Week of Sep 28 holds Oct 3 (fingers, forearms); week of Oct 5 holds the run.
    expect(segments).toEqual([["fingers", "1"], ["forearms", "1"], ["run", "1"]]);
    expect(within(training).getByRole("list", { name: "Body parts" }).textContent).toContain("forearms");

    const meals = within(charts).getByRole("region", { name: "Meals per day" });
    expect(meals.querySelector('g[data-day="2026-10-02"]')!.querySelectorAll("circle")).toHaveLength(2);
    expect(within(meals).getByText("650")).toBeTruthy();
    expect(within(meals).getByText("protein g")).toBeTruthy();

    expect(within(screen.getByRole("navigation", { name: "Days" })).getAllByRole("button")).toHaveLength(7);

    const columns = container.querySelectorAll("article[data-day]");
    expect([...columns].map((column) => column.getAttribute("data-day"))).toEqual([...DAYS].reverse());
    const oct3 = container.querySelector('article[data-day="2026-10-03"]') as HTMLElement;
    expect(within(oct3).getByRole("region", { name: "Tom" }).textContent).toContain("hangboarded forty minutes");
    const oct5 = container.querySelector('article[data-day="2026-10-05"]') as HTMLElement;
    const link = within(oct5).getByRole("link", { name: /Landed in Jarvis/ });
    expect(link.getAttribute("href")).toBe("https://github.com/Heffnt/Jarvis/pull/220");
    expect(within(oct5).getByText("Decided: hold all seven").tagName).toBe("SPAN");
  });

  it("draws an empty record as empty charts and empty days, never filled in", () => {
    const { container } = render(<HistoryView data={empty()} range={RANGE} today={RANGE.to} onRange={() => {}} />);
    expect(screen.getByRole("region", { name: "Weight over time" }).querySelectorAll("circle")).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Training per week by body part" }).querySelectorAll("rect")).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Meals per day" }).querySelectorAll("circle")).toHaveLength(0);
    const columns = container.querySelectorAll("article[data-day]");
    expect(columns).toHaveLength(7);
    for (const column of columns) expect(column.querySelectorAll("li")).toHaveLength(0);
  });

  it("shows Loading until the read answers", () => {
    render(<HistoryView data={undefined} range={RANGE} today={RANGE.to} onRange={() => {}} />);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("asks for a preset range ending today, and refuses a typed range that runs backwards", () => {
    const onRange = vi.fn();
    render(<HistoryView data={empty()} range={RANGE} today={RANGE.to} onRange={onRange} />);
    expect(screen.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "13 weeks" }));
    expect(onRange).toHaveBeenLastCalledWith({ from: "2026-07-09", to: "2026-10-07" });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-09" } });
    expect(onRange).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-20" } });
    expect(onRange).toHaveBeenLastCalledWith({ from: "2026-09-20", to: "2026-10-07" });
  });

  it("shows a read the record cut short", () => {
    render(<HistoryView data={{ ...empty(), cuts: ["Box-change rows: 3,000 read, stopped at the row limit."] }} range={RANGE} today={RANGE.to} onRange={() => {}} />);
    expect(screen.getByRole("list", { name: "Reads cut short" }).textContent).toContain("stopped at the row limit");
  });
});
