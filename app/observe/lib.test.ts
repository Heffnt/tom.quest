import { describe, expect, it } from "vitest";
import {
  ago,
  arrowHead,
  barEnd,
  borderPoint,
  fractionOf,
  isFailure,
  laneOfRun,
  mergeRowOf,
  jobOfRun,
  lasted,
  outcomeWords,
  packRows,
  repoOfRun,
  rulingHref,
  tallyFor,
  windowBounds,
  type PointEvent,
  type RulingRow,
  type RunMark,
  type WindowData,
} from "./lib";
import { NODES } from "./map-data";

const RUN: RunMark = {
  runId: "claude:box:abcdefgh",
  parentRunId: null,
  depth: 0,
  host: "box",
  environment: "worker",
  cli: "claude",
  kind: "job",
  status: "ended",
  model: "opus",
  origin: "cron:time-notes",
  startedAt: 1_000,
  lastLineAt: 2_000,
  endedReason: null,
  turns: null,
  toolCalls: null,
  totalTokens: null,
  costUsd: null,
  mergeKey: null,
  cwd: null,
  gitBranch: null,
  wikitomCommit: null,
};

const run = (over: Partial<RunMark>): RunMark => ({ ...RUN, ...over });

describe("the window", () => {
  it("ends at now and is as long as its kind", () => {
    const win = windowBounds("day", 0, 1_000_000_000);
    expect(win.to).toBe(1_000_000_000);
    expect(win.to - win.from).toBe(24 * 60 * 60 * 1000);
  });

  it("steps back by its own length, so previous and next land on the same edge", () => {
    const first = windowBounds("week", 0, 1_000_000_000);
    const second = windowBounds("week", 1, 1_000_000_000);
    expect(second.to).toBe(first.from);
  });
});

describe("a run's lane", () => {
  it("is the environment the record wrote and nothing else", () => {
    expect(laneOfRun(run({ environment: "session" }))).toBe("sessions");
    expect(laneOfRun(run({ environment: "worker" }))).toBe("workers");
    expect(laneOfRun(run({ environment: "runner" }))).toBe("runners");
  });

  it("runs a live run to now and a finished one to its last line", () => {
    expect(barEnd(run({ status: "running", lastLineAt: 5 }), 90)).toBe(90);
    expect(barEnd(run({ status: "ended", lastLineAt: 5 }), 90)).toBe(5);
  });
});

describe("the repository a run worked in", () => {
  it("is read off the working directory", () => {
    expect(repoOfRun(run({ cwd: "/root/work/tom.quest" }))).toBe("tom.quest");
    expect(repoOfRun(run({ cwd: "C:\\Users\\heffn\\Desktop\\WikiTom" }))).toBe("WikiTom");
  });

  it("looks above .claude when the directory is named for a worktree", () => {
    expect(
      repoOfRun(run({ cwd: "C:/Users/heffn/Desktop/ComplexMultiTrigger/.claude/worktrees/x" })),
    ).toBe("ComplexMultiTrigger");
  });

  it("answers nothing rather than guessing", () => {
    expect(repoOfRun(run({ cwd: "/tmp/scratch" }))).toBeNull();
    expect(repoOfRun(run({ cwd: null }))).toBeNull();
  });
});

describe("a failure", () => {
  it("is any -failed kind but the two that are not #tts-broken lines", () => {
    expect(isFailure("poll-gmail-failed")).toBe(true);
    expect(isFailure("job-failed")).toBe(true);
    expect(isFailure("slack-send-failed")).toBe(false);
    expect(isFailure("learning-revert-failed")).toBe(false);
    expect(isFailure("merge")).toBe(false);
  });
});

describe("a merge row", () => {
  const event = (data: unknown): PointEvent => ({
    id: "e1",
    at: 10,
    kind: "merge",
    key: "tom.quest:abc",
    todoId: null,
    data,
  });

  it("carries the repository, the sha and the commit key the gate is filed under", () => {
    const row = mergeRowOf(
      event({ repo: "tom.quest", sha: "abcdef1234", subject: "observe: a page", mainCheck: "abcdef1 is on main" }),
    );
    expect(row.repo).toBe("tom.quest");
    expect(row.subject).toBe("observe: a page");
    expect(row.commitKey).toBe("tom.quest@abcdef1234");
  });

  it("carries no address off this site", () => {
    const row = mergeRowOf(event({ repo: "tom.quest", sha: "abcdef1234" }));
    expect(JSON.stringify(row)).not.toContain("github.com");
  });
});

describe("the job a worker run belongs to", () => {
  it("is the name in its own origin, and nothing when it was spawned", () => {
    expect(jobOfRun(run({ origin: "cron:time-notes" }))).toBe("time-notes");
    expect(jobOfRun(run({ origin: "daemon" }))).toBeNull();
    expect(jobOfRun(run({ origin: "cron:digest", depth: 1 }))).toBeNull();
    expect(jobOfRun(run({ origin: "cron:digest", parentRunId: "claude:box:parentaa" }))).toBeNull();
  });
});

describe("how a run ended", () => {
  it("says only the numbers the row carries", () => {
    expect(outcomeWords(run({ status: "ended", turns: 3, toolCalls: 7, totalTokens: 1234, costUsd: 0.5 }))).toEqual([
      "ended",
      "3 turns",
      "7 tool calls",
      "1,234 tokens",
      "$0.50",
    ]);
    expect(outcomeWords(run({ status: "running" }))).toEqual(["running"]);
  });

  it("says how long it ran in the shortest true unit", () => {
    expect(lasted(run({ startedAt: 0, lastLineAt: 30_000 }), 0)).toBe("30s");
    expect(lasted(run({ startedAt: 0, lastLineAt: 5 * 60_000 }), 0)).toBe("5m");
  });
});

describe("a ruling's address", () => {
  const ruling = (over: Partial<RulingRow>): RulingRow => ({
    id: "r1",
    ruledAt: 1,
    verdict: "approve",
    sentence: null,
    subjectType: "life",
    todoId: "t1",
    batchId: null,
    repo: null,
    externalId: null,
    subject: "s",
    quote: null,
    ...over,
  });

  it("is the item link for a life todo and the batches tab for everything else", () => {
    expect(rulingHref(ruling({}))).toBe("/tts?item=t1");
    expect(rulingHref(ruling({ subjectType: "batch", todoId: null, batchId: "b1" }))).toBe(
      "/tts?tab=batches",
    );
  });
});

describe("stacking", () => {
  it("puts two marks that overlap in two sub-rows", () => {
    const items = [
      { start: 0, end: 10 },
      { start: 5, end: 15 },
      { start: 20, end: 25 },
    ];
    const rows = packRows(items, (i) => i.start, (i) => i.end, 0, 10);
    expect(rows[0]).toBe(0);
    expect(rows[1]).toBe(1);
    expect(rows[2]).toBe(0);
  });

  it("stops growing at its ceiling", () => {
    const items = Array.from({ length: 8 }, () => ({ start: 0, end: 10 }));
    const rows = packRows(items, (i) => i.start, (i) => i.end, 0, 3);
    expect(Math.max(...rows)).toBe(2);
  });
});

describe("the map's numbers", () => {
  const data: WindowData = {
    runs: [
      run({ runId: "a", environment: "session", host: "box", model: "opus", startedAt: 100 }),
      run({ runId: "b", environment: "worker", host: "box", model: "opus", startedAt: 200 }),
      run({ runId: "c", environment: "worker", host: "laptop", model: "sonnet", startedAt: 300, wikitomCommit: "deadbee" }),
    ],
    events: [
      { id: "m", at: 400, kind: "merge", key: null, todoId: null, data: null },
      { id: "f", at: 500, kind: "poll-gmail-failed", key: null, todoId: null, data: null },
      { id: "g", at: 600, kind: "tests-run", key: null, todoId: null, data: null },
    ],
    rulings: [
      {
        id: "r",
        ruledAt: 700,
        verdict: "approve",
        sentence: null,
        subjectType: "life",
        todoId: null,
        batchId: null,
        repo: null,
        externalId: null,
        subject: "",
        quote: null,
      },
    ],
    runners: [
      { experimentHost: "turing", endedAt: null, lastCheckInAt: 800 },
      { experimentHost: "turing", endedAt: 1, lastCheckInAt: 900 },
      { experimentHost: "box", endedAt: null, lastCheckInAt: 950 },
    ],
  };

  it("counts each lane off the rows it drew", () => {
    expect(tallyFor({ of: "lane", lane: "sessions" }, data, 0)).toEqual({ count: 1, lastAt: 100 });
    expect(tallyFor({ of: "lane", lane: "workers" }, data, 0)).toEqual({ count: 2, lastAt: 300 });
    expect(tallyFor({ of: "lane", lane: "merges" }, data, 0)).toEqual({ count: 1, lastAt: 400 });
    expect(tallyFor({ of: "lane", lane: "failures" }, data, 0)).toEqual({ count: 1, lastAt: 500 });
    expect(tallyFor({ of: "lane", lane: "rulings" }, data, 0)).toEqual({ count: 1, lastAt: 700 });
  });

  it("counts one kind of event on its own", () => {
    expect(tallyFor({ of: "events", kind: "merge" }, data, 0)).toEqual({ count: 1, lastAt: 400 });
    expect(tallyFor({ of: "events", kind: "tts-opened" }, data, 0)).toEqual({ count: 0, lastAt: null });
  });

  it("counts the host, the distinct models, the WikiTom commits and the gate rows", () => {
    expect(tallyFor({ of: "host", host: "box" }, data, 0).count).toBe(2);
    expect(tallyFor({ of: "models" }, data, 0).count).toBe(2);
    expect(tallyFor({ of: "wikitom" }, data, 0).count).toBe(1);
    expect(tallyFor({ of: "gate" }, data, 0).count).toBe(1);
  });

  it("counts only the live runners whose experiment is on the cluster", () => {
    expect(tallyFor({ of: "turing" }, data, 0)).toEqual({ count: 1, lastAt: 800 });
  });

  it("counts everything the window returned under the record", () => {
    expect(tallyFor({ of: "everything" }, data, 0).count).toBe(7);
  });
});

describe("the map's shape", () => {
  it("names every node an edge points at", () => {
    const ids = new Set(NODES.map((node) => node.id));
    expect(ids.size).toBe(NODES.length);
  });
});

describe("the arrows", () => {
  it("leaves a box at its own border", () => {
    const point = borderPoint({ x: 0, y: 0 }, 10, 5, { x: 100, y: 0 });
    expect(point).toEqual({ x: 10, y: 0 });
  });

  it("draws a head whose back corners sit either side of the line", () => {
    const points = arrowHead({ x: 0, y: 0 }, { x: 10, y: 0 }, 4, 2)
      .split(" ")
      .map((pair) => pair.split(",").map(Number));
    expect(points[0]).toEqual([10, 0]);
    expect(points[1][0]).toBeCloseTo(6);
    expect(points[2][0]).toBeCloseTo(6);
    expect(points[1][1] + points[2][1]).toBeCloseTo(0);
  });
});

describe("words for a time", () => {
  it("says nothing happened rather than inventing a moment", () => {
    expect(ago(null, 0)).toBe("—");
  });

  it("clamps a mark to the window it is drawn in", () => {
    expect(fractionOf(-5, { from: 0, to: 10 })).toBe(0);
    expect(fractionOf(50, { from: 0, to: 10 })).toBe(1);
    expect(fractionOf(5, { from: 0, to: 10 })).toBe(0.5);
  });
});
