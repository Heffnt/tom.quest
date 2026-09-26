// THE MAP, AS DATA. One list of nodes and one list of edges; the diagram is
// drawn from them and holds no geometry of its own, so a component that is
// added to Jarvis is a row here and nothing else.
//
// THE POSITIONS ARE THE FLOW, left to right. Tom is on the left, then the three
// surfaces he touches, then the record in the middle that everything is written
// into, then the Jarvis Box and the things it runs. Along the bottom sit the
// four resources those things reach for, each directly under what reaches for
// it.
//
// EVERY NODE SAYS WHAT PRESSING IT DOES and does exactly that one thing: a node
// either holds the timeline to one lane or opens a page of this site, never
// both, and never an address off it.

/** The seven lanes of the timeline, which are also the seven things counted.
 *  `box` is every change to the Jarvis Box (convex/boxChanges.ts) and every
 *  deploy of it. */
export type Lane = "sessions" | "workers" | "runners" | "rulings" | "merges" | "failures" | "box";

export const LANES: Lane[] = ["sessions", "workers", "runners", "rulings", "merges", "failures", "box"];

/** What a node's number counts. A `lane` tally is that lane's own marks; the
 *  rest are things the timeline has no lane for. */
export type Tally =
  | { of: "lane"; lane: Lane }
  /** Every row the window returned — runs, events and rulings together. */
  | { of: "everything" }
  /** Runs that ran on that host. */
  | { of: "host"; host: "box" | "laptop" }
  /** Distinct model names the window's runs named. */
  | { of: "models" }
  /** Distinct WikiTom commits the window's runs carried. */
  | { of: "wikitom" }
  /** The gate head rows recorded in the window. */
  | { of: "gate" }
  /** Events of one kind in the window. */
  | { of: "events"; kind: string };

/**
 * How a node is drawn. The shape carries what kind of thing it is, so the map
 * is not a grid of identical boxes.
 *
 * THE THREE STATUS COLOURS ARE NOT USED HERE. success, warning and error mean a
 * state everywhere else on the site, and a green GitHub box would be saying
 * something about GitHub's health that this page does not know. What is left is
 * the accent and the three text greys, which is enough: the shape does the
 * work.
 */
export type Shape =
  /** Tom. A pill, in the accent. */
  | "person"
  /** Something he touches: a page, a chat, a channel. */
  | "surface"
  /** Something that holds rows: the record, WikiTom. Hard corners. */
  | "store"
  /** Something that runs: the Jarvis Box, Turing, the merge gate. Chamfered. */
  | "machine"
  /** Runs, which are transient: a dashed edge. */
  | "work"
  /** Outside Tom's system: a faint dotted edge. */
  | "outside";

export type MapNode = {
  id: string;
  /** The vocabulary's word for it, and no other word. */
  label: string;
  /** What its number counts, in the plural, so the number is never bare. */
  unit: string;
  /** Centre, in the diagram's own units. */
  x: number;
  y: number;
  shape: Shape;
  tally: Tally;
  /** Pressing it holds the timeline to this lane. */
  filters?: Lane;
  /** Pressing it opens this page of tom.quest. */
  opens?: string;
  // A node with neither is the record, and pressing it gives the whole window
  // back. That needs no third field: one node has neither, and a flag saying
  // which would be a second way to spell the same fact.
};

/** A node's name. The edges below are typed on it, so an edge naming a node
 *  the map does not hold is a compile error rather than a drawing that throws
 *  when someone opens the page. */
export type NodeId = (typeof NODES)[number]["id"];

type MapEdge = {
  from: NodeId;
  to: NodeId;
  /** Both ends carry an arrowhead: the two components feed each other. */
  both?: boolean;
};

export const NODE_WIDTH = 150;
export const NODE_HEIGHT = 64;
export const MAP_WIDTH = 1090;
export const MAP_HEIGHT = 440;

const ROW_TOP = 60;
const ROW_MID = 170;
const ROW_LOW = 280;
const ROW_FLOOR = 385;

export const NODES = [
  // Tom.
  { id: "tom", label: "Tom", unit: "rulings", x: 80, y: ROW_MID, shape: "person", tally: { of: "lane", lane: "rulings" }, filters: "rulings" },

  // The surfaces he touches.
  { id: "sessions", label: "sessions", unit: "agents", x: 255, y: ROW_TOP, shape: "surface", tally: { of: "lane", lane: "sessions" }, filters: "sessions" },
  { id: "pages", label: "the pages", unit: "opens", x: 255, y: ROW_MID, shape: "surface", tally: { of: "events", kind: "tts-opened" }, opens: "/" },
  { id: "slack", label: "Slack", unit: "failures", x: 255, y: ROW_LOW, shape: "surface", tally: { of: "lane", lane: "failures" }, filters: "failures" },

  // What everything is written into.
  { id: "record", label: "the record", unit: "rows", x: 440, y: ROW_MID, shape: "store", tally: { of: "everything" } },

  // The box and what it runs.
  { id: "box", label: "the Jarvis Box", unit: "agents", x: 625, y: ROW_MID, shape: "machine", tally: { of: "host", host: "box" }, opens: "/agents" },
  { id: "workers", label: "workers", unit: "agents", x: 810, y: ROW_TOP, shape: "work", tally: { of: "lane", lane: "workers" }, filters: "workers" },
  { id: "runners", label: "runners", unit: "agents", x: 810, y: ROW_MID, shape: "work", tally: { of: "lane", lane: "runners" }, filters: "runners" },
  { id: "gate", label: "the merge gate", unit: "head rows", x: 995, y: ROW_MID, shape: "machine", tally: { of: "gate" }, filters: "merges" },

  // The resources, each under what reaches for it.
  { id: "wikitom", label: "WikiTom", unit: "commits", x: 440, y: ROW_FLOOR, shape: "store", tally: { of: "wikitom" }, opens: "/jarvis" },
  { id: "models", label: "the models", unit: "models", x: 625, y: ROW_FLOOR, shape: "outside", tally: { of: "models" }, opens: "/turing" },
  { id: "turing", label: "Turing", unit: "runner agents", x: 810, y: ROW_FLOOR, shape: "machine", tally: { of: "lane", lane: "runners" }, opens: "/turing" },
  { id: "github", label: "GitHub", unit: "merges", x: 995, y: ROW_FLOOR, shape: "outside", tally: { of: "lane", lane: "merges" }, filters: "merges" },
] as const satisfies readonly MapNode[];

export const EDGES: MapEdge[] = [
  { from: "tom", to: "sessions", both: true },
  { from: "tom", to: "pages" },
  { from: "tom", to: "slack", both: true },
  { from: "sessions", to: "record" },
  { from: "pages", to: "record", both: true },
  { from: "slack", to: "record", both: true },
  { from: "record", to: "box", both: true },
  { from: "box", to: "workers" },
  { from: "box", to: "runners" },
  { from: "box", to: "gate" },
  { from: "wikitom", to: "record", both: true },
  { from: "models", to: "box" },
  { from: "github", to: "gate", both: true },
];

/** What pressing this node does, in words, for its hover title. */
export function nodeAction(node: MapNode): string {
  if (node.filters !== undefined) return `holds the timeline to ${node.filters}`;
  if (node.opens !== undefined) return `opens ${node.opens}`;
  return "gives the whole window back";
}
