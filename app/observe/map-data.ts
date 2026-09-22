// THE MAP, AS DATA. One list of nodes and one list of edges; the diagram is
// drawn from them and holds no geometry of its own, so a component that is
// added to Jarvis is a row here and nothing else.
//
// Every node names the LANE it stands for, which is what a click on it filters
// the timeline to, and where its count comes from. A node with no lane is a
// component the record counts some other way (the models it ran under, the
// WikiTom commits it carried, the gate head rows it holds) or a place to open
// (Turing, the pages).

/** The six lanes of the timeline, which are also the six things counted. */
export type Lane = "sessions" | "workers" | "runners" | "rulings" | "merges" | "failures";

export const LANES: Lane[] = ["sessions", "workers", "runners", "rulings", "merges", "failures"];

/** What a node's number counts when it is not one of the six lanes. */
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
  /** Runners whose experiment runs on the cluster. */
  | { of: "turing" };

export type MapNode = {
  id: string;
  /** The vocabulary's word for it, and no other word. */
  label: string;
  /** Centre, in the diagram's own units. */
  x: number;
  y: number;
  tally: Tally;
  /** Where a click goes when the node stands for something outside the record.
   *  A node with a lane filters instead. */
  href?: string;
  /** Opens in a new tab: the two addresses that leave tom.quest. */
  external?: boolean;
};

export type MapEdge = {
  from: string;
  to: string;
  /** Both ends carry an arrowhead: the two components feed each other. */
  both?: boolean;
};

export const NODE_WIDTH = 150;
export const NODE_HEIGHT = 62;
export const MAP_WIDTH = 920;
export const MAP_HEIGHT = 400;

export const NODES: MapNode[] = [
  { id: "box", label: "the Jarvis Box", x: 90, y: 70, tally: { of: "host", host: "box" } },
  { id: "turing", label: "Turing", x: 90, y: 200, tally: { of: "turing" }, href: "/turing" },
  { id: "models", label: "the models", x: 90, y: 330, tally: { of: "models" } },

  { id: "sessions", label: "sessions", x: 330, y: 70, tally: { of: "lane", lane: "sessions" } },
  { id: "workers", label: "workers", x: 330, y: 200, tally: { of: "lane", lane: "workers" } },
  { id: "runners", label: "runners", x: 330, y: 330, tally: { of: "lane", lane: "runners" } },

  { id: "wikitom", label: "WikiTom", x: 570, y: 70, tally: { of: "wikitom" }, href: "https://github.com/Heffnt/WikiTom", external: true },
  { id: "record", label: "the record", x: 570, y: 200, tally: { of: "everything" } },
  { id: "gate", label: "the merge gate", x: 570, y: 330, tally: { of: "gate" } },

  { id: "pages", label: "the pages", x: 830, y: 70, tally: { of: "lane", lane: "rulings" } },
  { id: "slack", label: "Slack", x: 830, y: 200, tally: { of: "lane", lane: "failures" } },
  { id: "github", label: "GitHub", x: 830, y: 330, tally: { of: "lane", lane: "merges" } },
];

export const EDGES: MapEdge[] = [
  { from: "box", to: "sessions" },
  { from: "box", to: "workers" },
  { from: "box", to: "runners" },
  { from: "models", to: "sessions" },
  { from: "models", to: "workers" },
  { from: "models", to: "runners" },
  { from: "turing", to: "runners", both: true },
  { from: "sessions", to: "record" },
  { from: "workers", to: "record" },
  { from: "runners", to: "record" },
  { from: "wikitom", to: "record", both: true },
  { from: "record", to: "slack", both: true },
  { from: "record", to: "gate", both: true },
  { from: "gate", to: "github", both: true },
  { from: "record", to: "pages" },
];

export function nodeById(id: string): MapNode {
  const found = NODES.find((node) => node.id === id);
  if (found === undefined) throw new Error(`the map has no node ${id}`);
  return found;
}
