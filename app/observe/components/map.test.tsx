// The map draws every component, every arrow ends in a polygon rather than a
// marker element, and pressing a node that stands for a lane asks for that
// lane. Rendered rather than reasoned about, because the arrowheads are the
// part a reader notices when it is wrong.

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import Map from "./map";
import { EDGES, NODES } from "../map-data";
import type { WindowData } from "../lib";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const EMPTY: WindowData = { runs: [], events: [], rulings: [], runners: [] };

afterEach(() => cleanup());

describe("the map", () => {
  it("draws every node the data names", () => {
    const { container } = render(
      <Map data={EMPTY} now={0} focus={null} onFocus={() => {}} waiting={null} />,
    );
    for (const node of NODES) {
      expect(container.textContent).toContain(node.label);
    }
  });

  it("ends every arrow in a polygon, and uses no marker element", () => {
    const { container } = render(
      <Map data={EMPTY} now={0} focus={null} onFocus={() => {}} waiting={null} />,
    );
    const both = EDGES.filter((edge) => edge.both === true).length;
    expect(container.querySelectorAll("polygon").length).toBe(EDGES.length + both);
    expect(container.querySelectorAll("marker").length).toBe(0);
    expect(container.querySelectorAll("line").length).toBe(EDGES.length);
  });

  it("asks for the lane a node stands for, and asks for nothing when it is pressed again", () => {
    const asked: (string | null)[] = [];
    const { container, rerender } = render(
      <Map data={EMPTY} now={0} focus={null} onFocus={(next) => asked.push(next)} waiting={null} />,
    );
    const press = (label: string) => {
      const text = [...container.querySelectorAll("text")].find((node) => node.textContent === label);
      fireEvent.click(text!.closest("g, a")!);
    };
    press("sessions");
    expect(asked).toEqual(["sessions"]);
    rerender(
      <Map data={EMPTY} now={0} focus="sessions" onFocus={(next) => asked.push(next)} waiting={null} />,
    );
    press("sessions");
    expect(asked).toEqual(["sessions", null]);
  });

  it("carries the needs-you count only while something is waiting", () => {
    const { container, rerender } = render(
      <Map data={EMPTY} now={0} focus={null} onFocus={() => {}} waiting={{ waiting: 0, oldestAt: null }} />,
    );
    expect(container.textContent).not.toContain("#tts-needs-you");
    rerender(
      <Map data={EMPTY} now={0} focus={null} onFocus={() => {}} waiting={{ waiting: 3, oldestAt: 1 }} />,
    );
    expect(container.textContent).toContain("#tts-needs-you 3");
  });
});
