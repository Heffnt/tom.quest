// The drawing engine of Jarvis's registry of parts (shared/parts-drawing.mjs):
// the 93-row registry draws within one screen and with no crossing, the use
// states fill the overview and the map and nothing else, a head's diff is
// styled by the diff alone, and the geometry is what explainers.md's
// drawGraph draws. The fixture is Jarvis worker/parts.json at the commit that
// added serves and designed_by, its evidence references replaced by fixture
// ones (tom.quest is public).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LEGEND,
  LIMIT,
  USE_STATES,
  boxHeight,
  boxWidth,
  crossings,
  diagramsOf,
  diffDiagram,
  layoutGraph,
  removedStillRun,
  servesOnlyOutcomes,
  sizeOf,
} from "../parts-drawing.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "parts.json"), "utf8"));

/** Four programs: a starts b, c starts d, each placed in every drawing (Jarvis scripts/parts-diagrams.test.mjs). */
function rows(starts = { a: { x: 16, y: 60 }, b: { x: 600, y: 60 }, c: { x: 300, y: 200 }, d: { x: 600, y: 200 } }) {
  const row = (id, start) => ({
    id,
    name: id,
    type: "program",
    file: null,
    starts: start ? [start] : [],
    reads: [],
    writes: [],
    refuses: [],
    routes: [],
    schedule: null,
    fate: { type: "kept", by: null },
    serves: [{ outcomes: ["cost"] }],
    designed_by: "outcomes",
    note: "A part of the fixture.",
    place: {
      overview: { x: 30 + 120 * "abcd".indexOf(id), y: 60, region: "box" },
      fate: { x: 30 + 120 * "abcd".indexOf(id), y: 60 },
      starts: starts[id],
    },
  });
  return [row("a", "b"), row("b"), row("c", "d"), row("d")];
}

const drawing = (diagrams, id) => diagrams.find((d) => d.id === id);

describe("the sizes and the checks Jarvis's generator asserts", () => {
  it("sizes a box by its label lines", () => {
    expect(boxWidth(["deploy"])).toBe(90);
    expect(boxWidth(["pull-request-checks"])).toBe(184);
    expect(boxWidth(["a", "a second line that is long"])).toBe(206);
    expect(boxHeight(["one"])).toBe(36);
    expect(boxHeight(["one", "two"])).toBe(54);
  });

  it("names a drawn row with no place for a drawing", () => {
    const fixture = rows();
    delete fixture[2].place.starts;
    expect(diagramsOf(fixture).problems).toContain("c has no place for the drawing starts");
  });

  it("names an edge whose straight line passes through a box it does not connect", () => {
    const { diagrams } = diagramsOf(rows({ a: { x: 16, y: 60 }, b: { x: 600, y: 60 }, c: { x: 300, y: 60 }, d: { x: 300, y: 200 } }));
    expect(crossings(drawing(diagrams, "starts"))).toEqual(["in starts, the edge a -> b passes through c"]);
  });

  it("sizes a drawing by its largest node edge plus the pad", () => {
    const { diagrams } = diagramsOf(rows({ a: { x: 16, y: 60 }, b: { x: 1400, y: 60 }, c: { x: 300, y: 200 }, d: { x: 600, y: 200 } }));
    expect(sizeOf(drawing(diagrams, "starts"))).toEqual({ width: 1506, height: 252 });
  });
});

describe("the drawings of the registry", () => {
  it("draws seven drawings of the 93 rows with no problem, each within one screen and with no crossing", () => {
    const { diagrams, problems } = diagramsOf(REGISTRY, { commit: "8aca30b" });
    expect(problems).toEqual([]);
    expect(diagrams.map((d) => d.id)).toEqual(["legend", "overview", "map", "fate", "starts", "routes", "tools"]);
    for (const d of diagrams) {
      const { width, height } = sizeOf(d);
      expect(width, d.id).toBeLessThanOrEqual(LIMIT.width);
      expect(height, d.id).toBeLessThanOrEqual(LIMIT.height);
      expect(crossings(d), d.id).toEqual([]);
      expect(layoutGraph(d.nodes, d.edges).crossings, d.id).toEqual([]);
    }
    const running = REGISTRY.filter((row) => row.fate.type !== "proposed");
    const boxes = (id) => drawing(diagrams, id).nodes.filter((n) => n.type !== "region");
    expect(boxes("overview")).toHaveLength(running.length);
    expect(boxes("map")).toHaveLength(running.length);
    expect(drawing(diagrams, "map").nodes.filter((n) => n.type === "region").map((n) => n.label[0])).toEqual(["Design in session", "Govern by outcomes"]);
    expect(drawing(diagrams, "fate").nodes.filter((n) => n.type === "region")).toHaveLength(4);
    expect(drawing(diagrams, "overview").caption).toContain("at 8aca30b");
  });

  it("frames the map by designed_by, each box inside its frame", () => {
    const { diagrams } = diagramsOf(REGISTRY);
    const map = drawing(diagrams, "map");
    const byId = new Map(REGISTRY.map((row) => [row.id, row]));
    const frames = Object.fromEntries(map.nodes.filter((n) => n.type === "region").map((n) => [n.id.slice("region-".length), n]));
    for (const n of map.nodes.filter((n) => n.type !== "region")) {
      const f = frames[byId.get(n.id).designed_by];
      expect(n.x >= f.x && n.x + n.w <= f.x + f.w && n.y >= f.y && n.y + n.h <= f.y + f.h, n.id).toBe(true);
    }
  });

  it("fills every overview and map box by its use state, and no box of another drawing", () => {
    const states = Object.fromEntries(REGISTRY.map((row, i) => [row.id, USE_STATES[i % USE_STATES.length]]));
    const { diagrams } = diagramsOf(REGISTRY, { states });
    for (const id of ["overview", "map"]) {
      for (const n of drawing(diagrams, id).nodes.filter((n) => n.type !== "region")) expect(n.use, `${id} ${n.id}`).toBe(states[n.id]);
    }
    for (const id of ["fate", "starts", "routes", "tools"]) {
      expect(drawing(diagrams, id).nodes.filter((n) => n.use !== undefined), id).toEqual([]);
    }
  });

  it("outlines a running part by its fate on the overview", () => {
    const { diagrams } = diagramsOf(REGISTRY);
    const overview = drawing(diagrams, "overview");
    const removed = REGISTRY.find((row) => row.fate.type === "removed" && row.place?.overview);
    expect(overview.nodes.find((n) => n.id === removed.id).fate).toBe("removed");
    const kept = REGISTRY.find((row) => row.fate.type === "kept");
    expect(overview.nodes.find((n) => n.id === kept.id).fate).toBeUndefined();
  });

  it("leaves the map out while no row carries designed_by", () => {
    const fixture = rows().map((row) => {
      const copy = { ...row };
      delete copy.designed_by;
      return copy;
    });
    expect(diagramsOf(fixture).diagrams.map((d) => d.id)).not.toContain("map");
  });

  it("counts the parts ruled removed that still run, and those serving only outcomes", () => {
    expect(REGISTRY.filter(removedStillRun).length).toBeGreaterThan(0);
    expect(removedStillRun({ fate: { type: "removed" }, schedule: null, file: null })).toBe(false);
    expect(servesOnlyOutcomes({ serves: [{ outcomes: ["cost"] }] })).toBe(true);
    expect(servesOnlyOutcomes({ serves: [{ outcomes: ["cost"] }, { guarantee: "G1" }] })).toBe(false);
    expect(servesOnlyOutcomes({ serves: [] })).toBe(false);
  });
});

describe("a head's registry diff", () => {
  const changedRow = { ...REGISTRY.find((row) => row.id === "deploy"), note: "Changed by the head." };
  const addedRow = { ...REGISTRY.find((row) => row.id === "deploy"), id: "design-page-fixture", name: "a new part" };
  const diff = { base: "abcdef0123456789", added: ["design-page-fixture"], changed: ["deploy"], removed: ["sweep"], rows: { deploy: changedRow, "design-page-fixture": addedRow } };

  it("draws added rows proposed, changed rows replaced, removed rows removed, and the rest plain", () => {
    const { diagram, problems } = diffDiagram(REGISTRY, diff, { head: "Jarvis@1234567" });
    expect(problems).toEqual([]);
    const node = (id) => diagram.nodes.find((n) => n.id === id);
    expect(node("design-page-fixture")).toMatchObject({ fate: "proposed", label: ["a new part", "added"] });
    expect(node("deploy")).toMatchObject({ fate: "replaced", label: ["deploy", "changed"] });
    expect(node("sweep")).toMatchObject({ fate: "removed" });
    expect(node("sweep").label[1]).toBe("removed");
    const plain = diagram.nodes.filter((n) => n.type !== "region" && !["design-page-fixture", "deploy", "sweep"].includes(n.id));
    expect(plain.length).toBe(REGISTRY.length - 2);
    for (const n of plain) expect(n.fate, n.id).toBeUndefined();
    expect(diagram.caption).toBe("1 added, 1 changed, 1 removed against abcdef0, from the tests row of Jarvis@1234567.");
  });
});

describe("the geometry", () => {
  it("draws the legend: one shape per box, four arrows with heads, a bar on the deny arrow, no crossing", () => {
    const layout = layoutGraph(LEGEND.nodes, LEGEND.edges);
    const boxes = LEGEND.nodes.filter((n) => n.type !== "region" && n.type !== "point");
    expect(layout.shapes.map((s) => s.id)).toEqual(boxes.map((n) => n.id));
    expect(layout.regions).toHaveLength(1);
    expect(layout.arrows).toHaveLength(4);
    for (const a of layout.arrows) expect(a.head.split(" ")).toHaveLength(3);
    expect(layout.arrows.filter((a) => a.bar !== undefined).map((a) => a.from)).toEqual(["p4a"]);
    expect(layout.crossings).toEqual([]);
    // The five use states, under the fate row.
    expect(LEGEND.nodes.filter((n) => n.use !== undefined).map((n) => n.label[0])).toEqual(["Unverified", "Run", "In use", "Working", "Issue"]);
    const inUse = layout.shapes.find((s) => s.id === "u3");
    expect(inUse.primitives[0].style.fill).toBe("var(--use-in-use)");
  });

  it("ends an arrow on the drawn border of each shape", () => {
    const a = { id: "a", label: ["a"], x: 0, y: 0, w: 100, h: 40, type: "person" };
    const b = { id: "b", label: ["b"], x: 300, y: 0, w: 100, h: 40, type: "wall" };
    const [arrow] = layoutGraph([a, b], [{ from: "a", to: "b", label: "", type: "send" }]).arrows;
    // The ellipse's rightmost point, and the octagon's left edge.
    expect(arrow.line.x1).toBeCloseTo(100, 3);
    expect(arrow.head.split(" ")[0].split(",").map(Number)[0]).toBeCloseTo(300, 3);
  });

  it("reports an arrow through a box it does not connect", () => {
    const n = (id, x) => ({ id, label: [id], x, y: 0, w: 100, h: 40, type: "program" });
    const layout = layoutGraph([n("a", 0), n("c", 200), n("b", 400)], [{ from: "a", to: "b", label: "", type: "start" }]);
    expect(layout.crossings).toEqual(["the arrow a to b passes through c"]);
  });

  it("throws on a node of a type with no shape, naming it", () => {
    expect(() => layoutGraph([{ id: "x", label: ["x"], x: 0, y: 0, w: 10, h: 10, type: "kind" }], [])).toThrow("node x has the type \"kind\"");
  });
});
