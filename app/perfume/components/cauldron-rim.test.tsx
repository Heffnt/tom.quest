// The perfumes resting on the cauldron are the part of the brew graph that the
// word DESIGN.md §2 retired clung to longest: the Convex document has stored
// them under `cauldron` since the P2 rename, but the client store translated
// the field back to the retired word at the read boundary, and every consumer
// downstream — the snapshot type, the hand, this rim, the take action — kept
// it. (The retired word itself is spelled out only in vocabulary.test.ts, the
// guard that now keeps it out of every other file here.)
//
// A rename like that cannot be verified by rendering the live page, because the
// rim only appears when a brew actually holds a brewed perfume, and putting one
// there is a write. So this test supplies the snapshot directly: it renders the
// whole brew graph with two perfumes on the cauldron and clicks one.
//
// What it pins down, and would fail on if the rename came apart:
//   1. BrewGraph reads the resting perfumes from `snapshot.cauldron`. If the
//      field were renamed back, or half-renamed, no rim button would render.
//   2. Clicking one calls `actions.takeFromCauldron` with that perfume's
//      instance id — the client half of the Convex mutation of the same name.
//   3. Without the brewAndTake permission the buttons are disabled and no take
//      is sent, which is the WHAT gate of DESIGN.md §4 (server-enforced too).

import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import BrewGraph from "./brew-graph";
import { DEFAULT_UI } from "../lib/brew-types";
import type {
  BrewActions,
  BrewPermissions,
  BrewSnapshot,
  CauldronPerfume,
} from "../lib/brew-types";
import type { BrewHand } from "../lib/use-hand";

afterEach(cleanup);

// jsdom, the fake browser these tests run in, implements no media queries at
// all: window.matchMedia is simply absent. The brew graph's help popup asks it
// whether the viewport is narrow, so without this stub the whole render throws
// before any perfume is drawn. Every query answers "does not match", which is
// the wide-viewport branch.
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

// Every action is a no-op that records its name and arguments, so one recorder
// covers the whole BrewActions surface without listing its two dozen methods.
type Call = { name: string; args: unknown[] };

function recordingActions(calls: Call[]): BrewActions {
  return new Proxy({} as BrewActions, {
    get:
      (_target, key) =>
      (...args: unknown[]) =>
        calls.push({ name: String(key), args }),
  });
}

// The hand is the drag-carry state machine; the rim's click path does not use
// it, so a hand holding nothing is enough to render.
const IDLE_HAND: BrewHand = {
  hand: null,
  settleFx: null,
  pickUp: () => {},
  returnOne: () => false,
  settle: () => {},
  cancel: () => {},
  beginPress: () => {},
  moveHome: () => {},
};

function permissions(brewAndTake: boolean): BrewPermissions {
  return {
    registered: true,
    moveItems: true,
    brewAndTake,
    fillReturn: true,
    gift: true,
    pin: true,
    nickname: true,
    manageBrew: true,
    isAdmin: false,
  };
}

// Two perfumes resting on the cauldron: one Frenzy, and a stack of two Bright.
const RESTING: CauldronPerfume[] = [
  {
    instanceId: "inst-frenzy",
    perfumeId: "base:frenzy",
    count: 1,
    brewedByKey: "user:tom",
    witnesses: ["user:tom"],
    brewedAt: 1_700_000_000_000,
  },
  {
    instanceId: "inst-bright",
    perfumeId: "base:bright",
    count: 2,
    brewedByKey: "user:tom",
    witnesses: [],
    brewedAt: 1_700_000_001_000,
  },
];

function snapshot(cauldron: CauldronPerfume[]): BrewSnapshot {
  return {
    brewId: "brew-1",
    owner: "user:tom",
    ownerName: "Tom",
    nickname: null,
    seq: 1,
    isParty: false,
    items: [],
    strikePlays: [],
    wildPlays: [],
    pinned: null,
    cauldron,
    ui: DEFAULT_UI,
  };
}

function renderGraph(cauldron: CauldronPerfume[], canTake: boolean) {
  const calls: Call[] = [];
  render(
    <BrewGraph
      snapshot={snapshot(cauldron)}
      permissions={permissions(canTake)}
      actions={recordingActions(calls)}
      hand={IDLE_HAND}
      undo={{ canUndo: false, canRedo: false }}
      brewOptions={[]}
      blockers={[]}
      deepLink={null}
      members={[{ memberKey: "user:tom", name: "Tom" }]}
    />,
  );
  return calls;
}

describe("perfumes resting on the cauldron", () => {
  it("renders one button per resting perfume, read from snapshot.cauldron", () => {
    renderGraph(RESTING, true);
    const buttons = screen.getAllByTestId("cauldron-perfume");
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.getAttribute("data-perfume-key"))).toEqual([
      "base:frenzy",
      "base:bright",
    ]);
  });

  it("renders no rim when the cauldron is empty", () => {
    renderGraph([], true);
    expect(screen.queryAllByTestId("cauldron-perfume")).toHaveLength(0);
  });

  it("clicking one takes THAT instance through takeFromCauldron", () => {
    const calls = renderGraph(RESTING, true);
    screen.getAllByTestId("cauldron-perfume")[1].click();
    expect(calls).toEqual([{ name: "takeFromCauldron", args: ["inst-bright"] }]);
  });

  it("sends no take without the brewAndTake permission", () => {
    const calls = renderGraph(RESTING, false);
    const buttons = screen.getAllByTestId("cauldron-perfume");
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    buttons[0].click();
    expect(calls).toEqual([]);
  });
});
