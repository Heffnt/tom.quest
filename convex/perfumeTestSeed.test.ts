// The seed's contract: it refuses production, and where it does run it leaves
// the same rows every time no matter what the previous run left behind.
//
// The refusal tests are the important half. testSeed is a PUBLIC mutation that
// deletes members, brews and inventories, so the only thing standing between it
// and the one production deployment is the pair of locks in
// requireSeedableDeployment — and a lock nobody tests is a lock nobody has.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

type Harness = TestConvex<typeof schema>;

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const PRODUCTION_CLOUD_URL = "https://admired-chinchilla-140.convex.cloud";
const DEV_CLOUD_URL = "https://scrupulous-narwhal-1.convex.cloud";

const ROSES = "base:Noble Roses";
const APHASIA = "base:Aphasia Flower";
const PEAT = "base:Pemneath Peat";

// Open both locks: a deployment that is not production, with the seed switch on.
function openBothLocks() {
  vi.stubEnv("CONVEX_CLOUD_URL", DEV_CLOUD_URL);
  vi.stubEnv("PERFUME_TEST_SEED", "1");
}

async function setup(): Promise<{ t: Harness; ada: string; bee: string }> {
  const t = convexTest({ schema, modules });
  const ids = await t.run(async (ctx) => ({
    ada: await ctx.db.insert("users", {
      name: "Ada",
      email: "ada@tom.quest",
      role: "user",
    }),
    bee: await ctx.db.insert("users", {
      name: "Bee",
      email: "bee@tom.quest",
      role: "user",
    }),
  }));
  return { t, ada: `user:${ids.ada}`, bee: `user:${ids.bee}` };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("testSeed — the locks", () => {
  it("refuses the production deployment even with the switch on", async () => {
    const { t } = await setup();
    vi.stubEnv("CONVEX_CLOUD_URL", PRODUCTION_CLOUD_URL);
    vi.stubEnv("PERFUME_TEST_SEED", "1");
    await expect(
      t.mutation(api.perfumeTestSeed.testSeed, {
        members: [{ username: "ada" }],
      }),
    ).rejects.toThrow(/production deployment/);
  });

  it("refuses when the deployment cannot be identified at all", async () => {
    const { t } = await setup();
    vi.stubEnv("CONVEX_CLOUD_URL", "");
    vi.stubEnv("PERFUME_TEST_SEED", "1");
    await expect(
      t.mutation(api.perfumeTestSeed.testSeed, {
        members: [{ username: "ada" }],
      }),
    ).rejects.toThrow(/CONVEX_CLOUD_URL is unset/);
  });

  it("refuses a non-production deployment that has not switched the seed on", async () => {
    const { t } = await setup();
    vi.stubEnv("CONVEX_CLOUD_URL", DEV_CLOUD_URL);
    vi.stubEnv("PERFUME_TEST_SEED", "");
    await expect(
      t.mutation(api.perfumeTestSeed.testSeed, {
        members: [{ username: "ada" }],
      }),
    ).rejects.toThrow(/PERFUME_TEST_SEED/);
  });

  it("writes nothing when it refuses", async () => {
    const { t } = await setup();
    vi.stubEnv("CONVEX_CLOUD_URL", PRODUCTION_CLOUD_URL);
    vi.stubEnv("PERFUME_TEST_SEED", "1");
    await expect(
      t.mutation(api.perfumeTestSeed.testSeed, {
        members: [{ username: "ada" }],
      }),
    ).rejects.toThrow();
    const rows = await t.run(async (ctx) => ({
      members: await ctx.db.query("perfumeMembers").collect(),
      brews: await ctx.db.query("perfumeBrews").collect(),
      inventories: await ctx.db.query("perfumeInventories").collect(),
    }));
    expect(rows.members).toHaveLength(0);
    expect(rows.brews).toHaveLength(0);
    expect(rows.inventories).toHaveLength(0);
  });
});

describe("testSeed — what it seeds", () => {
  it("gives two members a joined row, the default stock, and one owned brew", async () => {
    const { t, ada, bee } = await setup();
    openBothLocks();
    const result = await t.mutation(api.perfumeTestSeed.testSeed, {
      members: [{ username: "ada" }, { username: "Bee" }],
    });

    expect(result.members.map((m) => m.memberKey)).toEqual([ada, bee]);
    expect(result.members.map((m) => m.name)).toEqual(["Ada", "Bee"]);

    const rows = await t.run(async (ctx) => ({
      members: await ctx.db.query("perfumeMembers").collect(),
      brews: await ctx.db.query("perfumeBrews").collect(),
      inventories: await ctx.db.query("perfumeInventories").collect(),
    }));
    expect(rows.members.map((m) => m.memberKey).sort()).toEqual(
      [ada, bee].sort(),
    );
    // one brew per member plus the single party brew
    expect(rows.brews).toHaveLength(3);
    expect(rows.brews.filter((b) => b.owner === null)).toHaveLength(1);
    expect(rows.brews.map((b) => b.items)).toEqual([[], [], []]);
    for (const inv of rows.inventories) {
      expect(inv.ingredients).toEqual({
        [ROSES]: 3,
        [APHASIA]: 2,
        [PEAT]: 1,
      });
      expect(inv.pures).toEqual({});
      expect(inv.perfumes).toEqual([]);
    }
    expect(result.partyBrewId).toBe(
      rows.brews.find((b) => b.owner === null)!._id,
    );
  });

  it("honours a per-member stock override", async () => {
    const { t } = await setup();
    openBothLocks();
    await t.mutation(api.perfumeTestSeed.testSeed, {
      members: [
        { username: "ada", ingredients: { [PEAT]: 4 }, pures: { "pure:N": 2 } },
      ],
    });
    const inv = await t.run(
      async (ctx) => await ctx.db.query("perfumeInventories").unique(),
    );
    expect(inv!.ingredients).toEqual({ [PEAT]: 4 });
    expect(inv!.pures).toEqual({ "pure:N": 2 });
  });

  it("returns the same state when run twice over a dirtied deployment", async () => {
    const { t, ada } = await setup();
    openBothLocks();
    const first = await t.mutation(api.perfumeTestSeed.testSeed, {
      members: [{ username: "ada" }, { username: "bee" }],
    });

    // dirty it the way a finished test run would: spend stock, drop an item in
    // a brew, and leave something in the shared party brew.
    await t.run(async (ctx) => {
      const inv = await ctx.db
        .query("perfumeInventories")
        .withIndex("by_member", (q) => q.eq("memberKey", ada))
        .unique();
      await ctx.db.patch(inv!._id, { ingredients: { [ROSES]: 1 } });
      await ctx.db.patch(first.members[0].brewId, {
        items: [{ key: ROSES, real: true, contributorKey: ada }],
      });
      await ctx.db.patch(first.partyBrewId, {
        items: [{ key: PEAT, real: true, contributorKey: ada }],
      });
    });

    const second = await t.mutation(api.perfumeTestSeed.testSeed, {
      members: [{ username: "ada" }, { username: "bee" }],
    });
    const rows = await t.run(async (ctx) => ({
      members: await ctx.db.query("perfumeMembers").collect(),
      brews: await ctx.db.query("perfumeBrews").collect(),
      inventories: await ctx.db.query("perfumeInventories").collect(),
    }));
    expect(rows.members).toHaveLength(2);
    expect(rows.inventories).toHaveLength(2);
    expect(rows.brews).toHaveLength(3);
    expect(rows.brews.every((b) => b.items.length === 0)).toBe(true);
    expect(rows.inventories.every((i) => i.ingredients[ROSES] === 3)).toBe(true);
    // the party brew is recreated, so its id is new and there is still one
    expect(second.partyBrewId).not.toBe(first.partyBrewId);
    expect(rows.brews.filter((b) => b.owner === null)).toHaveLength(1);
  });

  it("clears the undo log of the brews it deletes", async () => {
    const { t } = await setup();
    openBothLocks();
    const first = await t.mutation(api.perfumeTestSeed.testSeed, {
      members: [{ username: "ada" }],
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("perfumeUndo", {
        brewId: first.members[0].brewId,
        memberKey: first.members[0].memberKey,
        seq: 1,
        action: "moveIn",
        payload: {},
        inverse: {},
        done: true,
        at: Date.now(),
      });
    });
    await t.mutation(api.perfumeTestSeed.testSeed, {
      members: [{ username: "ada" }],
    });
    const undos = await t.run(
      async (ctx) => await ctx.db.query("perfumeUndo").collect(),
    );
    expect(undos).toHaveLength(0);
  });
});

describe("testSeed — bad input", () => {
  it("names the username that has no account", async () => {
    const { t } = await setup();
    openBothLocks();
    await expect(
      t.mutation(api.perfumeTestSeed.testSeed, {
        members: [{ username: "nobody" }],
      }),
    ).rejects.toThrow(/no account for username "nobody"/);
  });

  it("rejects an item key that is not in the catalog", async () => {
    const { t } = await setup();
    openBothLocks();
    await expect(
      t.mutation(api.perfumeTestSeed.testSeed, {
        members: [{ username: "ada", ingredients: { "base:Nettles": 2 } }],
      }),
    ).rejects.toThrow(/not a known ingredient key/);
  });

  it("rejects a perfume key in the ingredient section", async () => {
    const { t } = await setup();
    openBothLocks();
    await expect(
      t.mutation(api.perfumeTestSeed.testSeed, {
        members: [{ username: "ada", ingredients: { "base:black-gas": 1 } }],
      }),
    ).rejects.toThrow(/not a known ingredient key/);
  });

  it("rejects a count that is not a positive whole number", async () => {
    const { t } = await setup();
    openBothLocks();
    await expect(
      t.mutation(api.perfumeTestSeed.testSeed, {
        members: [{ username: "ada", ingredients: { [ROSES]: 0 } }],
      }),
    ).rejects.toThrow(/positive whole number/);
  });

  it("rejects two entries that normalise to the same account", async () => {
    const { t } = await setup();
    openBothLocks();
    await expect(
      t.mutation(api.perfumeTestSeed.testSeed, {
        members: [{ username: "Ada" }, { username: "ada" }],
      }),
    ).rejects.toThrow(/same account/);
  });

  it("rejects an empty member list", async () => {
    const { t } = await setup();
    openBothLocks();
    await expect(
      t.mutation(api.perfumeTestSeed.testSeed, { members: [] }),
    ).rejects.toThrow(/at least one member/);
  });
});
