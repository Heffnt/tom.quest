// THE POPOVER IS THE CONTRACT. app/AGENTS.md (Tom, 2026-08-29): one info
// mechanism, a tap-to-open popover whose content is what the control does on
// the backend with the exact call in mono; and every action label names its
// exact backend effect. explanations.test.ts holds the popovers themselves to
// the writing standard. This file holds the SURFACE to the rule, in three
// directions:
//
//   1. RENDERED. Every component under app/tts/components AND
//      app/sessions/components that has controls is rendered here, and every
//      control it puts on screen either carries a popover naming a call, or
//      fires nothing on the backend — which is checked by pressing it and
//      watching the mutations. The table of components is closed against BOTH
//      directories, so a new file with a control has to be added to it.
//      The sessions screens joined the closure with the lifeos update (phase
//      7): they are the second surface Tom presses buttons on, their controls
//      fire the session doors — send, interrupt, stop, force-close, rename,
//      model change, fork, the autonomous-fleet switch — and nothing was
//      holding them to the rule the TTS screens have been held to.
//   2. FIRED → NAMED. Every mutation the screens fire is named, verbatim, by a
//      popover somewhere on them, so a control wired to a mutation nobody
//      explains fails CI even if it renders somewhere this file cannot reach.
//   3. NAMED → REAL. Every call a popover names is a function this app
//      actually calls, so a popover left naming a call that has been renamed
//      or removed is noticed rather than quietly lying.
//
// Directions 2 and 3 are source scans rather than renders, for the same reason
// as the caption scan in explanations.test.ts: naming is checked across the
// population, not per file, because the batch card's verdicts are named in
// verdict-buttons.tsx and every other verdict surface reads that same text.
//
// What counts as fired: `useMutation(api.<module>.<function>)` in any .tsx
// under app/tts or app/sessions. What counts as named: the same
// `<module>.<function>` opening a string literal — the `call=` of an Info, the
// `call:` of an info table, a Caption's children — anywhere under those two.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { api } from "@/convex/_generated/api";
import { VERDICTS } from "../lib";

// ── The Convex stand-in ─────────────────────────────────────────────────────
// Queries read a table keyed by "module:function"; mutations record what they
// were called with. That recording is the whole point of direction 1: a
// control with no popover has to be shown to fire nothing.
const convex = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as string[],
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useQuery: (ref: unknown, args: unknown) =>
      args === "skip" ? undefined : convex.data[name(ref as never)],
    useMutation: (ref: unknown) => async () => {
      convex.calls.push(name(ref as never));
    },
    // The transcript pages its rows. CanLoadMore so its one control — "Load
    // earlier" — is on screen to be pressed.
    usePaginatedQuery: (ref: unknown) => ({
      results: (convex.data[name(ref as never)] as unknown[]) ?? [],
      status: "CanLoadMore",
      loadMore: () => {},
    }),
  };
});

// app/lib/auth pulls in Sentry, which does not load under jsdom. Nothing here
// depends on the answer beyond "this viewer may read TTS": every mutation on
// this surface is refused by Convex, not by the client.
vi.mock("@/app/lib/auth", () => ({
  useAuth: () => ({ isTom: true, canReadSurface: () => true }),
}));

import BatchCard, { type BatchGraph } from "./batch-card";
import BatchesTab from "./batches-tab";
import CalendarTab from "./calendar-tab";
import CodeTodoRow from "./code-todo-row";
import DetailDialog from "./detail-dialog";
import EverythingTab from "./everything-tab";
import GroundUpView from "./ground-up-view";
import OptionsRow from "./options-row";
import RepeatDialog from "./repeat-dialog";
import RepeatsStrip from "./repeats-strip";
import RulingDialog from "./ruling-dialog";
import TimeNoteField from "./time-note-field";
import TodoRow from "./todo-row";
import VerdictButtons from "./verdict-buttons";
import Composer from "@/app/sessions/components/composer";
import ForkDialog from "@/app/sessions/components/fork-dialog";
import ModelSelect from "@/app/sessions/components/model-select";
import OverflowExpand from "@/app/sessions/components/overflow-expand";
import Run from "@/app/sessions/components/run";
import RunList from "@/app/sessions/components/run-list";
import RunRow from "@/app/sessions/components/run-row";
import RunRows from "@/app/sessions/components/run-rows";

const APP = join(__dirname, "..", "..");
const TTS = join(APP, "tts");
const SESSIONS = join(APP, "sessions");
/** The two component directories the table of cases is closed against. */
const COMPONENT_DIRS = [join(TTS, "components"), join(SESSIONS, "components")];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

/** A file as this test names it: the path from `app/` down, forward slashes. */
const shortOf = (f: string) => f.slice(f.indexOf("app")).replace(/\\/g, "/");

const files = [...sources(TTS), ...sources(SESSIONS)].map((f) => ({
  short: shortOf(f),
  src: readFileSync(f, "utf8"),
}));

// ── Direction 1: every rendered control ─────────────────────────────────────

/**
 * `tts.recordEvent` is the exception, and the only one. It is not a control's
 * effect — it is the page recording that a control was used (a row was
 * expanded, an item was opened), fired alongside whatever the press actually
 * does. No control exists to fire it, so no label can name it.
 */
const TELEMETRY = getFunctionName(api.tts.recordEvent);

function fired(): string[] {
  return convex.calls.filter((c) => c !== TELEMETRY);
}

/** Every actionable control on screen — buttons and selects, minus the ⓘs. */
function controls(): HTMLElement[] {
  return [...document.body.querySelectorAll("button, select")].filter(
    (el) => el.getAttribute("aria-label") !== "what this does",
  ) as HTMLElement[];
}

/**
 * The popover that explains one control: the ⓘ in the smallest group that
 * holds this control and no other. A ⓘ further out than that explains a
 * section rather than this press, and does not count.
 */
function popoverFor(el: HTMLElement): HTMLElement | null {
  // The usual shape: the ⓘ is the control's next sibling and holds nothing
  // else. A row of chips each followed by its own ⓘ reads that way without
  // wrapping every pair, so this has to be recognised before the group walk
  // below, which would see three chips in one group and give up.
  const next = el.nextElementSibling;
  if (
    next !== null &&
    next.querySelectorAll("button:not([aria-label]), select").length === 0
  ) {
    const beside = within(next as HTMLElement).queryAllByLabelText(
      "what this does",
    );
    if (beside.length === 1) return beside[0];
  }

  let node = el.parentElement;
  while (node !== null && node !== document.body) {
    // Multiplicity first: a group holding a second control cannot say which
    // of them its ⓘ is for, so the search stops rather than letting a control
    // borrow its neighbour's popover.
    if (node.querySelectorAll("button:not([aria-label]), select").length > 1) {
      return null;
    }
    const infos = within(node).queryAllByLabelText("what this does");
    if (infos.length > 0) return infos[0];
    node = node.parentElement;
  }
  return null;
}

/** The mono line inside an opened popover — the exact call. */
function callNamed(info: HTMLElement): string {
  fireEvent.click(info);
  const panel = document.querySelector('[role="note"]');
  const mono = panel?.querySelector('[class*="font-mono"]');
  const text = mono?.textContent ?? "";
  fireEvent.keyDown(document, { key: "Escape" });
  return text;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_756_000_000_000;

const GRAPH: BatchGraph = {
  id: "batch-1",
  statement: "Land the lifeos update",
  groundUp: "<!DOCTYPE html><html><body><p>why</p></body></html>",
  tasks: [
    {
      id: "t1",
      statement: "Write the spec amendment",
      actor: "agent",
      status: "done",
      needs: [],
      readiness: "prepared",
      rulable: false,
    },
    {
      id: "t2",
      statement: "Ratify the amendment",
      actor: "tom",
      status: "active",
      needs: ["t1"],
      readiness: "prepared",
      groundUp: "<!DOCTYPE html><html><body><p>why</p></body></html>",
      rulable: true,
    },
  ],
  goals: [
    { id: "g1", statement: "The spec says what the system does", met: false, rulable: true },
  ],
};

const TODO = {
  _id: "t2",
  _creationTime: 0,
  batchId: "batch-1",
  kind: "task",
  statement: "Ratify the amendment",
  actor: "tom",
  needs: [],
  status: "active",
  readiness: "prepared",
  source: "tom",
  timingClass: "whenever",
  brief: "the brief",
  createdAt: NOW,
  updatedAt: NOW,
};

const BATCH = {
  _id: "batch-1",
  _creationTime: 0,
  statement: "Land the lifeos update",
  status: "active",
  updatedAt: NOW,
};

const MIRROR = {
  _id: "m1",
  _creationTime: 0,
  repo: "tom.quest",
  externalId: "todo-14",
  statement: "Fence the session repo list",
  tier: "now",
  status: "open",
  url: "https://example.invalid/todo-14",
  syncedAt: NOW,
};

const BRIEF = {
  _id: "b1",
  _creationTime: 0,
  repo: "tom.quest",
  externalId: "todo-14",
  brief: "what it is",
  recommendation: "approve",
  execClass: "box",
  preparedAt: NOW,
};

const REPEAT = {
  _id: "r1",
  _creationTime: 0,
  statement: "Practice",
  daysOfWeek: ["mon"],
  timeOfDay: "07:00",
  active: true,
  skipWhenCalendarHas: "standup",
};

const NOTE = {
  _id: "n1",
  _creationTime: 0,
  todoId: "t2",
  text: "before friday",
  status: "pending",
  createdAt: NOW,
};

// ── The sessions screens ────────────────────────────────────────────────────
// One live session, mid-run and with a stale daemon, because that posture puts
// every control on screen at once: send, interrupt, stop, and force close.
const SESSION = {
  _id: "s1",
  _creationTime: 0,
  title: "the lifeos update",
  status: "running",
  kind: "adhoc",
  mode: "interactive",
  repo: "tom.quest",
  model: "gpt-5.6-sol",
  createdAt: NOW,
  statusChangedAt: NOW,
};

// One row for the rows region and the row itself. A `tool-call`, because that
// is the kind whose compact line IS a control: it opens to full and then to
// raw, and a kind that is full already (user, assistant-text) would put no
// expand control on screen at all.
const ROW = {
  _id: "m1",
  _creationTime: 0,
  sessionId: "s1",
  seq: 1,
  kind: "tool-call",
  content: {
    toolName: "Read",
    toolUseId: "tu1",
    input: { file_path: "app/sessions/components/run.tsx" },
  },
  createdAt: NOW,
};

const AUTO_CONFIG = {
  enabled: false,
  defaultModel: "gpt-5.6-sol",
  maxLoadPerCpu: 0.8,
  minFreeMemMb: 1024,
  maxLiveAutonomous: 8,
  maxNewPerTick: 2,
};

function load() {
  convex.data = {
    [getFunctionName(api.claudeSessions.getSession)]: SESSION,
    [getFunctionName(api.claudeSessions.getAutoConfig)]: AUTO_CONFIG,
    [getFunctionName(api.claudeSessions.getDaemonHealth)]: null,
    [getFunctionName(api.claudeSessions.getMessages)]: [],
    [getFunctionName(api.claudeSessions.getStreamBuf)]: null,
    [getFunctionName(api.claudeSessions.getPendingInbound)]: [],
    [getFunctionName(api.tts.listTodos)]: [TODO],
    [getFunctionName(api.tts.listBatches)]: [BATCH],
    [getFunctionName(api.tts.listMirror)]: [MIRROR],
    [getFunctionName(api.ttsCode.listCodeBriefs)]: [BRIEF],
    [getFunctionName(api.ttsRulings.listRulings)]: [],
    [getFunctionName(api.tts.listTimeNotes)]: [NOTE],
    [getFunctionName(api.tts.listBlocks)]: [],
    // No tts.getToday: the calendar tab's today column is computed now, and
    // the query went with the fallback queue (the lifeos update, phase 7
    // jobs). An unanswered query reads as loading, which is what this fixture
    // wants of it anyway.
    [getFunctionName(api.ttsRepeats.listRepeats)]: [REPEAT],
    [getFunctionName(api.ttsCalendar.listCalendarEvents)]: [],
  };
}

const noop = () => {};

/** One entry per component under either directory that renders controls. */
const CASES: { file: string; render: () => void }[] = [
  {
    file: "app/tts/components/batch-card.tsx",
    render: () =>
      void render(
        <BatchCard
          graph={GRAPH}
          now={NOW}
          expanded
          onToggle={noop}
          onRule={noop}
          onDetail={noop}
          onGroundUp={noop}
          onOpenSession={noop}
        />,
      ),
  },
  { file: "app/tts/components/batches-tab.tsx", render: () => void render(<BatchesTab />) },
  { file: "app/tts/components/calendar-tab.tsx", render: () => void render(<CalendarTab />) },
  {
    file: "app/tts/components/code-todo-row.tsx",
    render: () =>
      void render(
        <CodeTodoRow
          row={MIRROR as never}
          brief={BRIEF as never}
          ruling={undefined}
          now={NOW}
          expanded
          onToggle={noop}
        />,
      ),
  },
  {
    file: "app/tts/components/detail-dialog.tsx",
    render: () =>
      void render(
        <DetailDialog
          item={{ kind: "batch", graph: GRAPH }}
          onClose={noop}
          onGroundUp={noop}
          onRule={noop}
        />,
      ),
  },
  {
    file: "app/tts/components/everything-tab.tsx",
    render: () => void render(<EverythingTab link={null} onLinkCleared={noop} />),
  },
  {
    file: "app/tts/components/ground-up-view.tsx",
    render: () =>
      void render(
        <GroundUpView title="t" content="<!DOCTYPE html><html></html>" onClose={noop} />,
      ),
  },
  {
    file: "app/tts/components/options-row.tsx",
    render: () => void render(<OptionsRow todo={TODO as never} rulable />),
  },
  {
    file: "app/tts/components/repeat-dialog.tsx",
    render: () => void render(<RepeatDialog rule={REPEAT as never} onClose={noop} />),
  },
  { file: "app/tts/components/repeats-strip.tsx", render: () => void render(<RepeatsStrip />) },
  {
    file: "app/tts/components/ruling-dialog.tsx",
    render: () =>
      void render(
        <RulingDialog
          action="revise"
          confirm="record revise"
          placeholder="the sentence"
          required
          call='ttsRulings.recordRuling({ todoId, verdict: "revise", sentence })'
          effect="what it does"
          statement="s"
          onConfirm={noop}
          onClose={noop}
        />,
      ),
  },
  {
    file: "app/tts/components/time-note-field.tsx",
    render: () =>
      void render(
        <TimeNoteField todoId={TODO._id as never} notes={[NOTE as never]} />,
      ),
  },
  {
    file: "app/tts/components/todo-row.tsx",
    render: () =>
      void render(
        <TodoRow
          todo={TODO as never}
          now={NOW}
          expanded
          onToggle={noop}
          intent="done"
          onIntentCleared={noop}
          timeNotes={[NOTE as never]}
        />,
      ),
  },
  {
    file: "app/tts/components/verdict-buttons.tsx",
    render: () =>
      void render(<VerdictButtons subject="todo" statement="s" onRule={noop} />),
  },
  {
    file: "app/sessions/components/composer.tsx",
    // daemonStale, so "Force close" is on screen with the rest.
    render: () =>
      void render(<Composer session={SESSION as never} daemonStale />),
  },
  {
    file: "app/sessions/components/fork-dialog.tsx",
    render: () =>
      void render(
        <ForkDialog
          fromModel="gpt-5.6-sol"
          toModel="gpt-5.6-terra"
          onConfirm={async () => {}}
          onClose={noop}
        />,
      ),
  },
  {
    file: "app/sessions/components/model-select.tsx",
    render: () =>
      void render(
        <ModelSelect ariaLabel="session model" value="gpt-5.6-sol" onChange={noop} />,
      ),
  },
  {
    file: "app/sessions/components/overflow-expand.tsx",
    render: () =>
      void render(
        <OverflowExpand messageId={"m1" as never} fullByteLength={40_000} />,
      ),
  },
  {
    file: "app/sessions/components/run-list.tsx",
    render: () =>
      void render(
        <RunList
          sessions={[SESSION as never]}
          now={NOW}
          onOpenSession={noop}
          onOpenRun={noop}
        />,
      ),
  },
  {
    file: "app/sessions/components/run-row.tsx",
    // source="run", so the raw level names runs.rows rather than the session
    // reader. The compact line is the control; pressing it is what proves the
    // three levels fire nothing on the backend.
    render: () => void render(<RunRow row={ROW as never} source="run" />),
  },
  {
    file: "app/sessions/components/run-rows.tsx",
    // CanLoadMore, so its one control — "load earlier rows" — is on screen.
    // source="session" is the branch that has one: a run pages the other way
    // and the same button reads "load later rows".
    render: () =>
      void render(
        <RunRows
          rows={[ROW as never]}
          pageStatus="CanLoadMore"
          loadMore={noop}
          source="session"
          depth={0}
          runKey="s1"
        />,
      ),
  },
  {
    file: "app/sessions/components/run.tsx",
    // depth 0 and a session id, because that is the only posture that draws
    // controls at all: the header's rename ⓘ and model select, the rows, and
    // the composer. daemonStale, so the composer's "Force close" comes with
    // them. The run row itself is left undefined (runs.get answers nothing) —
    // a session whose runs row has not landed is the common case, and the
    // header reads off the session either way.
    render: () =>
      void render(
        <Run
          sessionId={"s1" as never}
          depth={0}
          now={NOW}
          daemonStale
          daemonLastSeenAt={NOW}
          onBack={noop}
          onOpenRun={noop}
          onOpenSession={noop}
        />,
      ),
  },
];

describe("every control on the screens names its call, or fires none", () => {
  beforeEach(() => {
    convex.calls.length = 0;
    load();
    // reserveSessionTab and the block session opener claim a tab inside the
    // press; jsdom has no real one.
    vi.stubGlobal("open", () => null);
  });

  it("has one case per component in these directories that has controls", () => {
    const withControls = COMPONENT_DIRS.flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
        // info.tsx IS the mechanism: its two buttons are the ⓘ and the "more"
        // that opens the ground-up document, neither of them a control the
        // popover explains. info.test.tsx holds it to its own contract.
        .filter((f) => f !== "info.tsx")
        .filter((f) => /<button|<select/.test(readFileSync(join(dir, f), "utf8")))
        .map((f) => shortOf(join(dir, f))),
    );
    expect(CASES.map((c) => c.file).sort()).toEqual(withControls.sort());
  });

  for (const c of CASES) {
    it(`${c.file}`, () => {
      c.render();
      const seen = new Set<Element>();
      let checked = 0;
      // Pressing a control with no popover is what proves it fires nothing —
      // and a disclosure pressed that way reveals the controls underneath it,
      // which the next round checks. Four rounds reach every nesting on these
      // screens; a control already pressed is never pressed twice.
      for (let round = 0; round < 4; round++) {
        const fresh = controls().filter((el) => !seen.has(el));
        if (fresh.length === 0) break;
        for (const el of fresh) {
          seen.add(el);
          if (!el.isConnected) continue;
          const info = popoverFor(el);
          checked += 1;
          if (info !== null) {
            expect(callNamed(info)).toMatch(/^\w+\.\w+/);
            continue;
          }
          const before = fired().length;
          fireEvent.click(el);
          expect(
            fired().slice(before),
            `"${el.textContent}" in ${c.file} fires a mutation with no popover naming it`,
          ).toEqual([]);
        }
      }
      // A case that renders nothing would pass every assertion above.
      expect(checked).toBeGreaterThan(0);
      cleanup();
    });
  }
});

// ── Directions 2 and 3: the source scans ────────────────────────────────────

/** Every mutation a screen fires, with the files that fire it. */
const firedInSource = new Map<string, string[]>();
for (const { short, src } of files) {
  for (const m of src.matchAll(/useMutation\(\s*api\.(\w+)\.(\w+)\s*\)/g)) {
    const call = `${m[1]}.${m[2]}`;
    firedInSource.set(call, [...(firedInSource.get(call) ?? []), short]);
  }
}

/** Every call a popover names: `<module>.<function>` opening a literal. */
const named = new Set<string>();
for (const { src } of files) {
  for (const m of src.matchAll(/["'`]\s*(\w+)\.(\w+)[({\s]/g)) {
    named.add(`${m[1]}.${m[2]}`);
  }
}

/**
 * Every Convex function a popover could honestly name: the ones this app calls
 * as `api.<module>.<function>`, plus the ones convex/ exports — an internal
 * function a cron runs is never called from a screen, but naming it in a
 * popover ("what mints this at 4:30 a.m.") is exactly right.
 */
const real = new Set<string>();
function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== "_generated") walk(full, ext, out);
    } else if (ext.test(name)) out.push(full);
  }
  return out;
}
for (const f of walk(APP, /\.tsx?$/)) {
  for (const m of readFileSync(f, "utf8").matchAll(/api\.(\w+)\.(\w+)/g)) {
    real.add(`${m[1]}.${m[2]}`);
  }
}
const CONVEX = join(APP, "..", "convex");
for (const f of readdirSync(CONVEX).filter((n) => n.endsWith(".ts"))) {
  const mod = f.slice(0, -3);
  for (const m of readFileSync(join(CONVEX, f), "utf8").matchAll(
    /export const (\w+)\s*=/g,
  )) {
    real.add(`${mod}.${m[1]}`);
  }
}

describe("every mutation the screens fire is named by a popover", () => {
  it("finds fired mutations and named calls at all", () => {
    // A scan matching nothing would pass the assertions below while checking
    // nothing.
    expect(firedInSource.size).toBeGreaterThan(5);
    expect(named.size).toBeGreaterThan(5);
    expect(real.size).toBeGreaterThan(5);
  });

  for (const [call, where] of [...firedInSource].sort()) {
    it(`${call} (fired by ${where.join(", ")}) has a popover naming it`, () => {
      expect(named.has(call)).toBe(true);
    });
  }

  it("names no call this app does not make", () => {
    // The reverse direction: a popover left naming a call that was renamed or
    // removed is a lie told in small mono, and nothing else would catch it.
    expect([...named].filter((c) => !real.has(c)).sort()).toEqual([]);
  });

  it("offers no verdict outside the closed set", () => {
    // The closed set is lib.VERDICTS, which mirrors the union
    // convex/ttsRulings.ts accepts. "edit" and "defer" were both once labels
    // on this page; neither is a verdict.
    const allowed = new Set<string>(VERDICTS);
    const offered = new Set<string>();
    for (const { src } of files) {
      for (const m of src.matchAll(/verdict:\s*"([^"]+)"/g)) {
        // The verdict row builds its call from a template — `verdict:
        // "${verdict}"` — over lib.VERDICTS, so that form offers the four.
        if (/^\$\{\w+\}$/.test(m[1])) for (const v of VERDICTS) offered.add(v);
        else offered.add(m[1]);
      }
    }
    // Four at least, or the scan matched nothing and asserts nothing — which
    // is what the literal-only scan this replaced was doing.
    expect(offered.size).toBeGreaterThanOrEqual(4);
    expect([...offered].filter((v) => !allowed.has(v))).toEqual([]);
  });
});
