// The map draws every component, every arrow ends in a three-cornered polygon
// rather than a marker element, pressing a node that stands for a lane asks for
// that lane, and nothing on it leaves this site.

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import SystemMap from "./map";
import { EDGES, NODES } from "../map-data";
import type { WindowData } from "../lib";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const EMPTY: WindowData = { runs: [], events: [], rulings: [] };

const draw = (over: Partial<Parameters<typeof SystemMap>[0]> = {}) =>
  render(
    <SystemMap
      data={EMPTY}
      now={0}
      focus={null}
      onFocus={() => {}}
      waiting={null}
      {...over}
    />,
  );

afterEach(() => cleanup());

describe("the map", () => {
  it("draws every node the data names", () => {
    const { container } = draw();
    for (const node of NODES) expect(container.textContent).toContain(node.label);
  });

  it("gives every number its unit in words", () => {
    const { container } = draw();
    for (const node of NODES) expect(container.textContent).toContain(`0 ${node.unit}`);
  });

  it("ends every arrow in a polygon of three corners, and uses no marker element", () => {
    const { container } = draw();
    const heads = [...container.querySelectorAll("polygon")].filter(
      (polygon) => (polygon.getAttribute("points") ?? "").trim().split(/\s+/).length === 3,
    );
    const both = EDGES.filter((edge) => edge.both === true).length;
    expect(heads.length).toBe(EDGES.length + both);
    expect(container.querySelectorAll("marker").length).toBe(0);
    expect(container.querySelectorAll("line").length).toBe(EDGES.length);
  });

  it("says on every node what pressing it does", () => {
    const { container } = draw();
    const titles = [...container.querySelectorAll("title")].map((node) => node.textContent ?? "");
    expect(titles.length).toBe(NODES.length);
    for (const title of titles) {
      expect(/holds the timeline to|opens |gives the whole window back/.test(title)).toBe(true);
    }
  });

  it("never sends the reader off this site", () => {
    const { container } = draw();
    for (const link of container.querySelectorAll("a")) {
      expect(link.getAttribute("href")?.startsWith("/")).toBe(true);
    }
  });

  it("asks for the lane a node stands for, and asks for nothing when it is pressed again", () => {
    const asked: (string | null)[] = [];
    const { container, rerender } = draw({ onFocus: (next) => asked.push(next) });
    const press = (label: string) => {
      const text = [...container.querySelectorAll("text")].find((node) => node.textContent === label);
      fireEvent.click(text!.closest("g, a")!);
    };
    press("sessions");
    expect(asked).toEqual(["sessions"]);
    rerender(
      <SystemMap
        data={EMPTY}
        now={0}
        focus="sessions"
        onFocus={(next) => asked.push(next)}
        waiting={null}
      />,
    );
    press("sessions");
    expect(asked).toEqual(["sessions", null]);
  });

  it("carries the needs-you count only while something is waiting", () => {
    const { container, rerender } = draw({ waiting: { waiting: 0, oldestAt: null } });
    expect(container.textContent).not.toContain("#tts-needs-you");
    rerender(
      <SystemMap
        data={EMPTY}
        now={0}
        focus={null}
        onFocus={() => {}}
        waiting={{ waiting: 3, oldestAt: 1 }}
      />,
    );
    expect(container.textContent).toContain("#tts-needs-you 3");
  });
});
