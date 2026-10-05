// parts-drawing.mjs — the drawings of Jarvis's registry of parts, as data.
//
// THE ONE HOME of the drawing engine. tom.quest/design draws the registry the
// box posts (a `registry` event, shared/jarvis-events.mjs) with it, the
// thread's return draws a head's registry diff with it, and Jarvis
// scripts/parts-diagrams.mjs imports it (package tom-quest-shared) to write
// and check its committed page, so the box, which has no DOM, checks fit and
// crossings through the same code the page draws with.
//
// A REGISTRY ROW is one part of Jarvis (Jarvis worker/parts.json): `id`,
// `name`, `type`, `file`, `starts`, `reads`, `writes`, `refuses`, `routes`,
// `schedule`, `fate` ({ type, by }), `serves`, `designed_by`, `note` and
// `place` (agent-written positions, one per drawing).
//
// A HEAD'S REGISTRY DIFF is what the box's pull-request-checks job posts on a
// Jarvis head's tests row, `{ base, added, removed, changed, rows }`, checked
// by registryDiffOf in shared/jarvis-events.mjs; diffDiagram draws it.
//
// A DRAWING is `{ id, title, caption, nodes, edges }`. A node is `{ id, label
// (lines), x, y, w, h, type, fate?, use? }` in diagram units; `type` selects
// its shape (the nine of the legend, `region` for a frame, `point` for an
// invisible line end), `fate` its outline (replaced, removed, proposed; a
// kept part has none) and `use` its fill (the part's use state). An edge is
// `{ from, to, label, type }`, type one of send, start, read, deny.
//
// Ported from two places: `diagramsOf` and its helpers from Jarvis
// scripts/parts-diagrams.mjs (at the commit that renamed kind to type), and
// `layoutGraph` from the `drawGraph` of WikiTom model-of-tom/explainers.md,
// the version whose arrows end on the drawn border of every shape and which
// checks crossings point by point. `layoutGraph` computes what `drawGraph`
// drew and returns it as data; the page's renderer maps it to SVG elements.
//
// Plain ESM with no imports (shared/AGENTS.md).

/** The one-screen limit of a drawing, in diagram units. */
export const LIMIT = { width: 1450, height: 750 };

// A drawing's size is its largest node edge plus this pad.
const PAD = 16;
const LINE_HEIGHT = 18;
const ONE_LINE_HEIGHT = 36;

/** A part's use state (convex/jarvis/partStates.ts), the fill of its box. */
/** @type {const} */
export const USE_STATES = ["unverified", "run", "in use", "working", "issue"];

// The shapes a node may name: the nine of the legend, the frame and the point.
const SHAPES = ["person", "page", "program", "agent", "store", "external", "wall", "document", "state", "region", "point"];

/** A part the registry rules removed that is still in the tree: it names a
 *  schedule entry or a file (the registry check keeps a named file existing). */
export function removedStillRun(row) {
  return row.fate.type === "removed" && (row.schedule !== null || row.file !== null);
}

/** A part whose serves names only outcomes: it exists for no sentence of his. */
export function servesOnlyOutcomes(row) {
  return row.serves.length > 0 && row.serves.every((item) => "outcomes" in item);
}

/** A box's width for its label lines: the first line at 15px, the second at 13px. */
export function boxWidth(label) {
  const widths = label.map((line, i) => line.length * (i === 0 ? 8.2 : 6.8));
  return Math.max(90, Math.ceil((Math.max(...widths) + 28) / 2) * 2);
}

/** A box's height for its number of label lines. */
export function boxHeight(label) {
  return ONE_LINE_HEIGHT + LINE_HEIGHT * (label.length - 1);
}

const EDGE_TYPES = { starts: "start", reads: "read", writes: "send", refuses: "deny" };

/** The regions of the overview, in the order a row's place.overview.region names them. */
export const OVERVIEW_REGIONS = {
  meets: "Where Tom meets Jarvis",
  site: "tom.quest",
  box: "The box",
  outside: "Outside",
};
/** The frames of the fate drawing, by fate.type. */
export const FATE_REGIONS = { kept: "Kept", replaced: "Replaced", removed: "Removed", proposed: "Proposed" };
/** The frames of the map drawing, by designed_by. */
export const MAP_REGIONS = { tom: "Design in session", outcomes: "Govern by outcomes" };

const CAPTION_END = "generated from worker/parts.json at the commit that holds this page.";

/**
 * The legend: one shape per type, one line style per relation, the frame, the
 * four fate styles, and the five use states. The first four rows are the
 * legend of WikiTom model-of-tom/explainers.md; the use row is this drawing's.
 */
export const LEGEND = {
  id: "legend",
  title: "Legend",
  caption: `The legend: one shape per type of part, one line style per relation, the four fate styles and the five use states, the same in every drawing below; ${CAPTION_END}`,
  nodes: [
    { id: "l1", label: ["Tom"], x: 16, y: 16, w: 140, h: 56, type: "person" },
    { id: "l2", label: ["A page", "on tom.quest"], x: 171, y: 16, w: 140, h: 56, type: "page" },
    { id: "l3", label: ["A program", "on the box"], x: 326, y: 16, w: 140, h: 56, type: "program" },
    { id: "l4", label: ["An agent", "a model at work"], x: 481, y: 16, w: 140, h: 56, type: "agent" },
    { id: "l5", label: ["A store", "data at rest"], x: 636, y: 16, w: 140, h: 56, type: "store" },
    { id: "l6", label: ["Outside party"], x: 791, y: 16, w: 140, h: 56, type: "external" },
    { id: "l7", label: ["A wall", "can refuse"], x: 946, y: 16, w: 140, h: 56, type: "wall" },
    { id: "l8", label: ["A record row", "or document"], x: 1101, y: 16, w: 140, h: 56, type: "document" },
    { id: "l9", label: ["A state"], x: 1256, y: 16, w: 140, h: 56, type: "state" },
    { id: "p1a", label: [""], x: 30, y: 128, w: 2, h: 2, type: "point" },
    { id: "p1b", label: [""], x: 230, y: 128, w: 2, h: 2, type: "point" },
    { id: "p2a", label: [""], x: 330, y: 128, w: 2, h: 2, type: "point" },
    { id: "p2b", label: [""], x: 530, y: 128, w: 2, h: 2, type: "point" },
    { id: "p3a", label: [""], x: 630, y: 128, w: 2, h: 2, type: "point" },
    { id: "p3b", label: [""], x: 830, y: 128, w: 2, h: 2, type: "point" },
    { id: "p4a", label: [""], x: 930, y: 128, w: 2, h: 2, type: "point" },
    { id: "p4b", label: [""], x: 1130, y: 128, w: 2, h: 2, type: "point" },
    { id: "lr", label: ["A group of parts"], x: 1180, y: 100, w: 216, h: 50, type: "region" },
    { id: "f1", label: ["Kept"], x: 16, y: 180, w: 170, h: 56, type: "program" },
    { id: "f2", label: ["Replaced", "→ what replaces it"], x: 201, y: 180, w: 170, h: 56, type: "program", fate: "replaced" },
    { id: "f3", label: ["Removed"], x: 386, y: 180, w: 170, h: 56, type: "program", fate: "removed" },
    { id: "f4", label: ["Proposed"], x: 571, y: 180, w: 170, h: 56, type: "program", fate: "proposed" },
    { id: "u1", label: ["Unverified"], x: 16, y: 252, w: 140, h: 56, type: "program", use: "unverified" },
    { id: "u2", label: ["Run"], x: 171, y: 252, w: 140, h: 56, type: "program", use: "run" },
    { id: "u3", label: ["In use"], x: 326, y: 252, w: 140, h: 56, type: "program", use: "in use" },
    { id: "u4", label: ["Working"], x: 481, y: 252, w: 140, h: 56, type: "program", use: "working" },
    { id: "u5", label: ["Issue"], x: 636, y: 252, w: 140, h: 56, type: "program", use: "issue" },
  ],
  edges: [
    { from: "p1a", to: "p1b", label: "sends or writes", type: "send" },
    { from: "p2a", to: "p2b", label: "starts", type: "start" },
    { from: "p3a", to: "p3b", label: "reads", type: "read" },
    { from: "p4a", to: "p4b", label: "can refuse", type: "deny" },
  ],
};

/** A node for `row` in the drawing `diagram`, at its place, or a problem naming the row. */
function placed(row, diagram, label, problems, extra = {}) {
  const at = row.place?.[diagram];
  if (!Number.isFinite(at?.x) || !Number.isFinite(at?.y)) {
    problems.push(`${row.id} has no place for the drawing ${diagram}`);
    return null;
  }
  return { id: row.id, label, x: at.x, y: at.y, w: boxWidth(label), h: boxHeight(label), type: row.type, ...extra };
}

/** One region frame around its members, its name above them. */
function frame(id, name, members) {
  const x = Math.min(...members.map((n) => n.x)) - 14;
  const y = Math.min(...members.map((n) => n.y)) - 32;
  return {
    id,
    label: [name],
    x,
    y,
    w: Math.max(...members.map((n) => n.x + n.w)) + 14 - x,
    h: Math.max(...members.map((n) => n.y + n.h)) + 14 - y,
    type: "region",
  };
}

const edgesOf = (rows, keep) =>
  rows.flatMap((row) =>
    Object.entries(EDGE_TYPES).flatMap(([field, type]) =>
      keep(row, field) ? row[field].map((to) => ({ from: row.id, to, label: "", type })) : [],
    ),
  );

/** The fate style a node carries: none for kept. */
const fateOf = (row) => (row.fate.type === "kept" ? {} : { fate: row.fate.type });

// The map drawing's rows: one box per running part, in file order, in columns
// of MAP_ROWS boxes 46 units apart (the overview's spacing), inside the frame
// of its designed_by. The drawing has no edges, so a computed position cannot
// make a crossing.
const MAP_TOP = 62;
const MAP_STEP = 46;
const MAP_ROWS = Math.floor((LIMIT.height - PAD - 14 - ONE_LINE_HEIGHT - MAP_TOP) / MAP_STEP) + 1;
const MAP_GAP = 16;

function mapNodes(rows, extraOf) {
  const nodes = [];
  let x = 30;
  for (const key of Object.keys(MAP_REGIONS)) {
    const members = rows.filter((row) => row.designed_by === key);
    for (let start = 0; start < members.length; start += MAP_ROWS) {
      const column = members.slice(start, start + MAP_ROWS).map((row, i) => {
        const label = [row.name];
        return { id: row.id, label, x, y: MAP_TOP + i * MAP_STEP, w: boxWidth(label), h: boxHeight(label), type: row.type, ...extraOf(row) };
      });
      nodes.push(...column);
      x += Math.max(...column.map((n) => n.w)) + MAP_GAP;
    }
    // The next frame starts past this one's border and a gap.
    if (members.length > 0) x += 28 + MAP_GAP;
  }
  return nodes;
}

/**
 * The drawings, built from the rows: the legend, the overview, the map, the
 * fate drawing, who starts whom, the record's routes and the tools.
 * `states` (part id to use state) fills the overview's and the map's boxes;
 * `commit` names the registry's commit in each caption. `problems` collects
 * every row the drawings could not place.
 */
export function diagramsOf(rows, { states, commit } = {}) {
  const problems = [];
  const end = commit ? `drawn from worker/parts.json at ${commit}.` : CAPTION_END;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const running = rows.filter((row) => row.fate.type !== "proposed");
  const nodes = (list, diagram, labelOf = (row) => [row.name], extraOf = () => ({})) =>
    list.map((row) => placed(row, diagram, labelOf(row), problems, extraOf(row))).filter(Boolean);
  const stateOf = (row) => {
    const state = states?.[row.id];
    return USE_STATES.includes(state) ? { use: state } : {};
  };
  const styled = (row) => ({ ...fateOf(row), ...stateOf(row) });

  // The overview: every running part, framed by the region its place names,
  // filled by its use state and outlined by its fate.
  const overviewNodes = nodes(running, "overview", undefined, styled);
  const regions = Object.entries(OVERVIEW_REGIONS).flatMap(([key, name]) => {
    const members = overviewNodes.filter((n) => byId.get(n.id).place.overview.region === key);
    return members.length > 0 ? [frame(`region-${key}`, name, members)] : [];
  });
  for (const n of overviewNodes) {
    if (!(byId.get(n.id).place.overview.region in OVERVIEW_REGIONS)) problems.push(`${n.id} has no region of the overview in its place`);
  }
  const overview = {
    id: "overview",
    title: "Every running part",
    caption: `Every part of Jarvis that runs today, in the region where it runs; ${end}`,
    nodes: [...regions, ...overviewNodes],
    edges: [],
  };

  // The map: every running part, framed by who designs it. Drawn only once
  // the rows carry designed_by.
  const designed = running.filter((row) => row.designed_by !== undefined);
  for (const row of designed) {
    if (!(row.designed_by in MAP_REGIONS)) problems.push(`${row.id} has designed_by ${JSON.stringify(row.designed_by)}, not one of ${Object.keys(MAP_REGIONS).join(", ")}`);
  }
  const mapped = mapNodes(designed, styled);
  const map = {
    id: "map",
    title: "What you design in session, and what outcomes govern",
    caption: `Every running part, in the frame of who designs it; ${end}`,
    nodes: [
      ...Object.entries(MAP_REGIONS).flatMap(([key, name]) => {
        const members = mapped.filter((n) => byId.get(n.id).designed_by === key);
        return members.length > 0 ? [frame(`region-${key}`, name, members)] : [];
      }),
      ...mapped,
    ],
    edges: [],
  };

  // The fate of every row in 2.0, framed by fate.
  const fateLabel = (row) => (row.fate.by ? [row.name, `by ${byId.get(row.fate.by)?.name ?? row.fate.by}`] : [row.name]);
  const fateNodes = nodes(rows, "fate", fateLabel, fateOf);
  const fate = {
    id: "fate",
    title: "The fate of each part in 2.0",
    caption: `Every row in its fate: kept with its type's outline, replaced amber and dashed, removed grey and struck, proposed blue and dashed, its second line the part that takes its place; ${end}`,
    nodes: [...fateFrames(fateNodes, (n) => byId.get(n.id).fate.type), ...fateNodes],
    edges: [],
  };

  // Who starts whom: every running part in a starts edge, but the starts of the
  // tools in worker/bin, which the tools drawing draws. The rows with a
  // schedule entry are framed together, and a part that starts every one of
  // them (tick) is drawn with one arrow to the frame: eighteen arrows from one
  // box to boxes in a column cannot be drawn without crossing those boxes.
  const isTool = (row) => typeof row.file === "string" && row.file.startsWith("worker/bin/");
  const startEdges = edgesOf(running, (row, field) => field === "starts" && !isTool(row));
  const scheduled = new Set(running.filter((row) => row.schedule !== null).map((row) => row.id));
  const schedulers = new Set(running.filter((row) => scheduled.size > 0 && [...scheduled].every((id) => row.starts.includes(id))).map((row) => row.id));
  const drawnStarts = [
    ...startEdges.filter((e) => !(schedulers.has(e.from) && scheduled.has(e.to))),
    ...[...schedulers].map((from) => ({ from, to: "region-schedule", label: "every entry", type: "start" })),
  ];
  const inStarts = new Set(startEdges.flatMap((e) => [e.from, e.to]));
  const startNodes = nodes(running.filter((row) => inStarts.has(row.id)), "starts", undefined, fateOf);
  const scheduleFrame = startNodes.filter((n) => scheduled.has(n.id));
  const starts = {
    id: "starts",
    title: "Who starts whom",
    caption: `Each dashed arrow is one entry of a row's starts, a process the part spawns or a part's entry it calls in process to run it; the frame holds the rows with an entry in worker/jobs/schedule.json, and the arrow to the frame stands for one start of each; the tools' starts are in the tools drawing; ${end}`,
    nodes: [...(scheduleFrame.length > 0 ? [frame("region-schedule", "schedule.json", scheduleFrame)] : []), ...startNodes],
    edges: drawnStarts,
  };

  // The record's routes: each part that spells one, to its route prefixes, to the record.
  const callers = running.filter((row) => row.routes.length > 0);
  const prefixOf = (route) => route.slice(0, route.indexOf("/", 1) + 1);
  const prefixes = [...new Set(callers.flatMap((row) => row.routes.map(prefixOf)))].sort();
  const record = byId.get("record");
  const callerNodes = nodes(callers, "routes", undefined, fateOf);
  const recordNode = record ? placed(record, "routes", [record.name], problems) : null;
  const prefixNodes = prefixes.map((prefix, i) => {
    const count = new Set(callers.flatMap((row) => row.routes.filter((r) => prefixOf(r) === prefix))).size;
    const label = [prefix, `${count} route${count === 1 ? "" : "s"}`];
    const at = record?.place?.routes?.prefixes?.[prefix];
    if (!Number.isFinite(at?.x) || !Number.isFinite(at?.y)) {
      problems.push(`record has no place for the route prefix ${prefix} in the drawing routes`);
      return null;
    }
    return { id: `prefix-${i}`, label, x: at.x, y: at.y, w: boxWidth(label), h: boxHeight(label), type: "document" };
  }).filter(Boolean);
  const prefixId = (prefix) => `prefix-${prefixes.indexOf(prefix)}`;
  const routes = {
    id: "routes",
    title: "The record's routes",
    caption: `Each part whose file spells a record route, joined to the prefixes of the routes it spells, and each prefix to the record; ${end}`,
    nodes: [...callerNodes, ...prefixNodes, ...(recordNode ? [recordNode] : [])],
    edges: [
      ...callers.flatMap((row) => [...new Set(row.routes.map(prefixOf))].map((p) => ({ from: row.id, to: prefixId(p), label: "", type: "send" }))),
      ...prefixes.map((p) => ({ from: prefixId(p), to: "record", label: "", type: "send" })),
    ],
  };

  // The tools: each tool in worker/bin, the implementations the tools start, and
  // what the tools and implementations start, read and write.
  const tools = running.filter((row) => typeof row.file === "string" && row.file.startsWith("worker/bin/"));
  const toolIds = new Set(tools.map((row) => row.id));
  const implementations = new Set(tools.flatMap((row) => row.starts).filter((id) => !toolIds.has(id)));
  const doors = new Set([...toolIds, ...implementations]);
  const toolEdges = edgesOf(running.filter((row) => doors.has(row.id)), (row, field) => field !== "refuses");
  const toolsDrawn = new Set([...doors, ...toolEdges.map((e) => e.to)]);
  const toolsDiagram = {
    id: "tools",
    title: "The tools",
    caption: `Each tool in worker/bin, the implementation it starts, and the parts those start, read and write; ${end}`,
    nodes: nodes(running.filter((row) => toolsDrawn.has(row.id)), "tools", undefined, fateOf),
    edges: toolEdges,
  };

  const diagrams = [LEGEND, overview, ...(mapped.length > 0 ? [map] : []), fate, starts, routes, toolsDiagram];
  return { diagrams, problems };
}

/** The four fate frames around the nodes `fateTypeOf` sorts into them. */
function fateFrames(fateNodes, fateTypeOf) {
  return Object.entries(FATE_REGIONS).flatMap(([type, name]) => {
    const members = fateNodes.filter((n) => fateTypeOf(n) === type);
    return members.length > 0 ? [frame(`region-${type}`, name, members)] : [];
  });
}

/**
 * What a head does to the registry, in one drawing: every row of the base
 * and every added row, at its place in the fate drawing (the head's row for
 * an added or changed id, the base's for the rest), framed by its own fate,
 * and styled by the diff alone: added in the proposed style, changed in the
 * replaced style, removed in the removed style, the rest plain. `head` names
 * the head the diff was posted for, in the caption.
 */
export function diffDiagram(baseRows, registryDiff, { head } = {}) {
  const problems = [];
  const added = new Set(registryDiff.added);
  const changed = new Set(registryDiff.changed);
  const removed = new Set(registryDiff.removed);
  const headRow = (row) => registryDiff.rows[row.id] ?? row;
  const baseIds = new Set(baseRows.map((row) => row.id));
  const drawn = [
    ...baseRows.map((row) => (changed.has(row.id) ? headRow(row) : row)),
    ...registryDiff.added.filter((id) => !baseIds.has(id) && registryDiff.rows[id]).map((id) => registryDiff.rows[id]),
  ];
  const styleOf = (id) =>
    added.has(id) ? { fate: "proposed", word: "added" }
      : changed.has(id) ? { fate: "replaced", word: "changed" }
        : removed.has(id) ? { fate: "removed", word: "removed" }
          : null;
  const nodes = drawn
    .map((row) => {
      const style = styleOf(row.id);
      const label = style === null ? [row.name] : [row.name, style.word];
      return placed(row, "fate", label, problems, style === null ? {} : { fate: style.fate });
    })
    .filter(Boolean);
  const fateTypeOf = new Map(drawn.map((row) => [row.id, row.fate?.type]));
  const base7 = registryDiff.base.slice(0, 7);
  return {
    diagram: {
      id: "diff",
      title: "What the head does to the registry",
      caption: `${added.size} added, ${changed.size} changed, ${removed.size} removed against ${base7}${head ? `, from the tests row of ${head}` : ""}.`,
      nodes: [...fateFrames(nodes, (n) => fateTypeOf.get(n.id)), ...nodes],
      edges: [],
    },
    problems,
  };
}

/** Where a segment, as a parameter in (0, 1), is inside a box's open interior, or null. */
function insideInterval(x1, y1, x2, y2, box) {
  let low = 0;
  let high = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - box.x], [dx, box.x + box.w - x1], [-dy, y1 - box.y], [dy, box.y + box.h - y1]]) {
    if (p === 0) {
      if (q <= 0) return null;
    } else {
      const t = q / p;
      if (p < 0) low = Math.max(low, t);
      else high = Math.min(high, t);
    }
  }
  return high - low > 1e-9 ? [low, high] : null;
}

/** Every edge whose straight line, centre to centre, passes through a box it does not connect. */
export function crossings(diagram) {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const boxes = diagram.nodes.filter((n) => n.type !== "region");
  const centre = (n) => [n.x + n.w / 2, n.y + n.h / 2];
  const out = [];
  for (const e of diagram.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) {
      out.push(`in ${diagram.id}, the edge ${e.from} -> ${e.to} names a node the drawing does not hold`);
      continue;
    }
    // An arrow to a region frame ends at the frame's border, as the drawing draws it.
    let [x1, y1] = centre(a);
    let [x2, y2] = centre(b);
    if (b.type === "region") {
      const t = insideInterval(x1, y1, x2, y2, b)?.[0] ?? 1;
      [x2, y2] = [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    }
    if (a.type === "region") {
      const t = insideInterval(x2, y2, x1, y1, a)?.[0] ?? 1;
      [x1, y1] = [x2 + (x1 - x2) * t, y2 + (y1 - y2) * t];
    }
    for (const n of boxes) {
      if (n === a || n === b) continue;
      if (insideInterval(x1, y1, x2, y2, n)) out.push(`in ${diagram.id}, the edge ${e.from} -> ${e.to} passes through ${n.id}`);
    }
  }
  return out;
}

/** A drawing's size as it is drawn: its largest node edge plus the pad. */
export function sizeOf(diagram) {
  return {
    width: Math.max(...diagram.nodes.map((n) => n.x + n.w)) + PAD,
    height: Math.max(...diagram.nodes.map((n) => n.y + n.h)) + PAD,
  };
}

// ── The geometry, as data ───────────────────────────────────────────────────
// What explainers.md's drawGraph draws, computed without a DOM. A primitive is
// `{ tag, attrs, style }`, one SVG element; the renderer adds nothing to it.

const RADIUS = 8;
const STORE_RY = 7; // the cylinder's end ellipses, as drawn
const WALL_CUT = 12; // the octagon's corner cut, as drawn
const DOC_FOLD = 12; // the document's folded corner, as drawn
const HEAD_LENGTH = 11;
const HEAD_HALF_WIDTH = 5.5;
const DASH = { send: "", start: "8 5", read: "2 5", deny: "" };

const centreOf = (n) => [n.x + n.w / 2, n.y + n.h / 2];

function insideRoundedRect(n, px, py, r) {
  const [cx, cy] = centreOf(n);
  const ax = Math.abs(px - cx), ay = Math.abs(py - cy);
  const hw = n.w / 2, hh = n.h / 2;
  if (ax > hw || ay > hh) return false;
  if (ax <= hw - r || ay <= hh - r) return true;
  return (ax - (hw - r)) ** 2 + (ay - (hh - r)) ** 2 <= r * r;
}

/** Whether a point lies inside the shape drawn for n. */
function inside(n, px, py) {
  const [cx, cy] = centreOf(n);
  const hw = n.w / 2, hh = n.h / 2;
  const inRect = Math.abs(px - cx) <= hw && Math.abs(py - cy) <= hh;
  if (n.type === "person") return ((px - cx) / hw) ** 2 + ((py - cy) / hh) ** 2 <= 1;
  if (n.type === "state") return insideRoundedRect(n, px, py, Math.min(hw, hh));
  if (n.type === "store") {
    const inEnd = (ey) => ((px - cx) / hw) ** 2 + ((py - ey) / STORE_RY) ** 2 <= 1;
    const inCore = Math.abs(px - cx) <= hw && py >= n.y + STORE_RY && py <= n.y + n.h - STORE_RY;
    return inCore || inEnd(n.y + STORE_RY) || inEnd(n.y + n.h - STORE_RY);
  }
  if (n.type === "wall") return inRect && Math.abs(px - cx) + Math.abs(py - cy) <= hw + hh - WALL_CUT;
  if (n.type === "document") {
    if (!inRect) return false;
    const fx = px - (n.x + n.w - DOC_FOLD), fy = py - n.y;
    return !(fx > 0 && fy < DOC_FOLD && fx > fy);
  }
  return insideRoundedRect(n, px, py, RADIUS);
}

/** Where the ray from n's centre toward (tx, ty) meets n's drawn border: every
 *  shape is star-shaped from its centre, so a binary search on the distance
 *  finds it. */
function exitPoint(n, tx, ty) {
  const [cx, cy] = centreOf(n);
  if (n.type === "point") return [cx, cy];
  const dx = tx - cx;
  const dy = ty - cy;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [cx, cy];
  const ux = dx / len, uy = dy / len;
  let lo = 0, hi = n.w / 2 + n.h / 2;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (inside(n, cx + ux * mid, cy + uy * mid)) lo = mid; else hi = mid;
  }
  return [cx + ux * lo, cy + uy * lo];
}

/** Whether the arrow from (x1, y1) to (x2, y2) passes through n: points every
 *  half unit along it, tested with the inside test the arrows' ends use. */
function crosses(x1, y1, x2, y2, n) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len === 0) return false;
  const steps = Math.ceil(len / 0.5);
  for (let k = 0; k <= steps; k++) {
    const t = Math.min(k * 0.5, len) / len;
    if (inside(n, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return true;
  }
  return false;
}

/** The CSS variable a use state fills a box with. */
const stateFill = (use) => `var(--use-${use.replace(/ /g, "-")})`;

/** One node's primitives and label lines. */
function shapeOf(n) {
  const fill = n.use ? stateFill(n.use) : `var(--node-${n.type}-fill)`;
  const stroke = n.fate === "replaced" ? "var(--replaced)" : n.fate === "removed" ? "var(--muted)" : n.fate === "proposed" ? "var(--proposed)" : `var(--node-${n.type}-stroke)`;
  const style = { fill, stroke, strokeWidth: "1.4" };
  if (n.fate) style.strokeDasharray = "5 4";
  if (n.fate === "removed") style.opacity = "0.6";
  const { x, y, w, h } = n;
  const primitives = [];
  const add = (tag, attrs, s) => primitives.push({ tag, attrs, style: s });
  if (n.type === "person") {
    add("ellipse", { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 }, style);
  } else if (n.type === "store") {
    add("path", { d: `M${x},${y + STORE_RY} a${w / 2},${STORE_RY} 0 0 1 ${w},0 v${h - 2 * STORE_RY} a${w / 2},${STORE_RY} 0 0 1 -${w},0 z` }, style);
    add("path", { d: `M${x},${y + STORE_RY} a${w / 2},${STORE_RY} 0 0 0 ${w},0` }, { ...style, fill: "none" });
  } else if (n.type === "wall") {
    const c = WALL_CUT;
    const pts = [[x + c, y], [x + w - c, y], [x + w, y + c], [x + w, y + h - c], [x + w - c, y + h], [x + c, y + h], [x, y + h - c], [x, y + c]];
    add("polygon", { points: pts.map((p) => p.join(",")).join(" ") }, style);
  } else if (n.type === "document") {
    const f = DOC_FOLD;
    add("path", { d: `M${x},${y} h${w - f} l${f},${f} v${h - f} h-${w} z` }, style);
    add("path", { d: `M${x + w - f},${y} v${f} h${f}` }, { ...style, fill: "none", strokeWidth: "1.2" });
  } else if (n.type === "state") {
    add("rect", { x, y, width: w, height: h, rx: h / 2, ry: h / 2 }, style);
  } else if (n.type === "external") {
    add("rect", { x, y, width: w, height: h, rx: RADIUS, ry: RADIUS }, { ...style, strokeDasharray: "5 4" });
  } else {
    add("rect", { x, y, width: w, height: h, rx: RADIUS, ry: RADIUS }, style);
    if (n.type === "agent") {
      add("rect", { x: x + 4, y: y + 4, width: w - 8, height: h - 8, rx: RADIUS - 3, ry: RADIUS - 3 }, { ...style, fill: "none", strokeWidth: "1.2" });
    }
    if (n.type === "page") {
      add("path", { d: `M${x},${y + 11} v-${11 - RADIUS} a${RADIUS},${RADIUS} 0 0 1 ${RADIUS},-${RADIUS} h${w - 2 * RADIUS} a${RADIUS},${RADIUS} 0 0 1 ${RADIUS},${RADIUS} v${11 - RADIUS} z` }, { fill: stroke, opacity: "0.55" });
    }
  }
  if (n.fate === "removed") {
    add("line", { x1: x + 6, y1: y + h - 6, x2: x + w - 6, y2: y + 6 }, { stroke: "var(--muted)", strokeWidth: "1.6" });
  }
  const [cx, cy] = centreOf(n);
  const offset = n.type === "page" ? 5 : n.type === "store" ? 4 : 0;
  const top = cy + offset - ((n.label.length - 1) * LINE_HEIGHT) / 2;
  const labels = n.label.map((text, i) => ({ x: cx, y: top + i * LINE_HEIGHT, text, size: i === 0 ? 15 : 13, weight: i === 0 ? 600 : 400 }));
  return { id: n.id, primitives, labels };
}

/**
 * The geometry of one drawing: `{ width, height, regions, arrows, shapes,
 * crossings }`. Regions are drawn first, arrows next and shapes last, so no
 * arrow crosses a box's text. An arrow runs from border to border, its head a
 * polygon from its angle, a deny arrow with a bar behind the head, a label
 * beside the line on its upper side. `crossings` names every arrow that
 * passes through a box it does not connect. A node of a type with no shape
 * throws, naming the node.
 */
export function layoutGraph(nodes, edges) {
  for (const n of nodes) {
    if (!SHAPES.includes(n.type)) throw new Error(`node ${n.id} has the type ${JSON.stringify(n.type)}, which has no shape`);
  }
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const width = Math.max(...nodes.map((n) => n.x + n.w)) + PAD;
  const height = Math.max(...nodes.map((n) => n.y + n.h)) + PAD;
  const regions = nodes.filter((n) => n.type === "region").map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, label: n.label[0].toUpperCase() }));
  const boxes = nodes.filter((n) => n.type !== "region");
  const found = [];
  const arrows = edges.map((e) => {
    const from = byId[e.from];
    const to = byId[e.to];
    if (!from || !to) throw new Error(`the edge ${e.from} -> ${e.to} names a node the drawing does not hold`);
    const type = e.type || "send";
    const colour = type === "deny" ? "var(--deny)" : "var(--diagram-line)";
    const [x1, y1] = exitPoint(from, ...centreOf(to));
    const [x2, y2] = exitPoint(to, ...centreOf(from));
    for (const n of boxes) {
      if (n === from || n === to || n.type === "point") continue;
      if (crosses(x1, y1, x2, y2, n)) found.push(`the arrow ${e.from} to ${e.to} passes through ${n.id}`);
    }
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const bx = x2 - HEAD_LENGTH * cos; // the middle of the arrowhead's base
    const by = y2 - HEAD_LENGTH * sin;
    const head = [
      [x2, y2],
      [bx + HEAD_HALF_WIDTH * sin, by - HEAD_HALF_WIDTH * cos],
      [bx - HEAD_HALF_WIDTH * sin, by + HEAD_HALF_WIDTH * cos],
    ];
    const arrow = {
      from: e.from,
      to: e.to,
      line: { x1, y1, x2: bx, y2: by },
      head: head.map((p) => p.join(",")).join(" "),
      colour,
      width: type === "deny" ? "2" : "1.6",
      dash: DASH[type] ?? "",
    };
    if (type === "deny") {
      const gx = bx - 6 * cos, gy = by - 6 * sin;
      arrow.bar = { x1: gx + 7 * sin, y1: gy - 7 * cos, x2: gx - 7 * sin, y2: gy + 7 * cos };
    }
    if (e.label) {
      let nx = -sin;
      let ny = cos;
      if (ny > 0 || (ny === 0 && nx > 0)) { nx = -nx; ny = -ny; }
      arrow.label = {
        x: (x1 + x2) / 2 + nx * 10,
        y: (y1 + y2) / 2 + ny * 10,
        text: e.label,
        anchor: Math.abs(nx) < 0.3 ? "middle" : nx < 0 ? "end" : "start",
        baseline: ny < -0.9 ? "auto" : "middle",
      };
    }
    return arrow;
  });
  const shapes = boxes.filter((n) => n.type !== "point").map(shapeOf);
  return { width, height, regions, arrows, shapes, crossings: found };
}
