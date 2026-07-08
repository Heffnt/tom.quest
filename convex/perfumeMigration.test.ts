// Ship-migration suite (convex/perfumeMigration.ts) — proves the three jobs of
// migrate (DESIGN.md §§2,4,9): the arg-driven member merge, deprecated-field
// stripping, and pinned {perfumeId, recipeIndex} → {perfumeId} conversion, plus
// the headline property: IDEMPOTENCE (running twice is a no-op).
//
// Fixtures are planted directly with t.run so we can construct rows carrying the
// deprecated shapes (contributorName, provenance, giftEvents, owners, and the
// old pinned shape) that the live mutations no longer write.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

type Harness = TestConvex<typeof schema>;

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const PURE_N = "pure:N";
const ICHOR = "base:Ichorberries";

// A raw member row (memberKey is the identity we merge on).
async function plantMember(t: Harness, memberKey: string, name: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("perfumeMembers", {
      memberKey,
      name,
      color: "#fff",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    });
  });
}

async function inventoryOf(t: Harness, memberKey: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("perfumeInventories")
      .withIndex("by_member", (q) => q.eq("memberKey", memberKey))
      .unique(),
  );
}

async function brewsOwnedBy(t: Harness, owner: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("perfumeBrews")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .collect(),
  );
}

describe("perfumeMigration.migrate", () => {
  it("merges a duplicate member into the real one: stacks summed, perfumes moved, brews & references reassigned, row deleted", async () => {
    const t = convexTest({ schema, modules });
    const fromKey = "anon:tom-dupe";
    const toKey = "user:tom-real";
    await plantMember(t, fromKey, "tom");
    await plantMember(t, toKey, "tom");

    // fromKey inventory: an ingredient stack, a pure stack, and a perfume
    // instance (whose witnesses name fromKey — should be rewritten).
    await t.run(async (ctx) => {
      await ctx.db.insert("perfumeInventories", {
        memberKey: fromKey,
        ingredients: { [ICHOR]: 2 },
        pures: { [PURE_N]: 3 },
        perfumes: [
          {
            instanceId: "inst:from-1",
            perfumeId: "base:black-gas",
            brewedByKey: fromKey,
            witnesses: [fromKey, toKey],
            brewedAt: 1,
          },
        ],
        updatedAt: 1,
      });
    });
    // toKey inventory: overlapping stacks (should sum) + one perfume.
    await t.run(async (ctx) => {
      await ctx.db.insert("perfumeInventories", {
        memberKey: toKey,
        ingredients: { [ICHOR]: 5 },
        pures: {},
        perfumes: [
          {
            instanceId: "inst:to-1",
            perfumeId: "base:black-gas",
            brewedByKey: toKey,
            witnesses: [],
            brewedAt: 2,
          },
        ],
        updatedAt: 2,
      });
    });

    // A brew owned by fromKey (seq 1), and toKey already owns one (seq 1) — after
    // reassign the seqs must not collide.
    const fromBrewId = await t.run(async (ctx) =>
      ctx.db.insert("perfumeBrews", {
        owner: fromKey,
        nickname: null,
        seq: 1,
        items: [{ key: PURE_N, real: true, contributorKey: fromKey }],
        strikePlays: [],
        wildPlays: [],
        pinned: null,
        cauldron: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("perfumeBrews", {
        owner: toKey,
        nickname: null,
        seq: 1,
        items: [],
        strikePlays: [],
        wildPlays: [],
        pinned: null,
        cauldron: [],
        createdAt: 2,
        updatedAt: 2,
      }),
    );
    // The party brew holds an item contributed by fromKey and a cauldron perfume
    // brewed by fromKey — both references must be rewritten to toKey.
    const partyBrewId = await t.run(async (ctx) =>
      ctx.db.insert("perfumeBrews", {
        owner: null,
        nickname: null,
        seq: 0,
        items: [
          { key: PURE_N, real: true, contributorKey: fromKey },
          { key: ICHOR, real: false, contributorKey: toKey },
        ],
        strikePlays: [],
        wildPlays: [],
        pinned: null,
        cauldron: [
          {
            instanceId: "inst:party-1",
            perfumeId: "base:black-gas",
            count: 1,
            brewedByKey: fromKey,
            witnesses: [fromKey, toKey],
            brewedAt: 3,
          },
        ],
        createdAt: 3,
        updatedAt: 3,
      }),
    );

    await t.mutation(internal.perfumeMigration.migrate, {
      mergeMembers: [{ fromKey, toKey }],
    });

    // fromKey member row and inventory are gone.
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("perfumeMembers")
          .withIndex("by_member", (q) => q.eq("memberKey", fromKey))
          .unique(),
      ),
    ).toBeNull();
    expect(await inventoryOf(t, fromKey)).toBeNull();

    // toKey inventory: stacks summed, perfume instances merged, provenance keys
    // rewritten off the deleted fromKey.
    const toInv = (await inventoryOf(t, toKey))!;
    expect(toInv.ingredients[ICHOR]).toBe(7); // 5 + 2
    expect(toInv.pures[PURE_N]).toBe(3);
    expect(toInv.perfumes).toHaveLength(2);
    const moved = toInv.perfumes.find((p) => p.instanceId === "inst:from-1")!;
    expect(moved.brewedByKey).toBe(toKey);
    expect(moved.witnesses).toEqual([toKey]); // fromKey→toKey, deduped

    // Brews: fromKey now owns none; toKey owns both, with distinct seqs.
    expect(await brewsOwnedBy(t, fromKey)).toHaveLength(0);
    const toBrews = await brewsOwnedBy(t, toKey);
    expect(toBrews).toHaveLength(2);
    const seqs = toBrews.map((b) => b.seq).sort();
    expect(new Set(seqs).size).toBe(2); // no collision
    const reassigned = toBrews.find((b) => String(b._id) === String(fromBrewId))!;
    expect(reassigned.owner).toBe(toKey);
    expect(reassigned.items[0].contributorKey).toBe(toKey);

    // Party brew: contributor + cauldron provenance rewritten to toKey.
    const party = await t.run(async (ctx) => ctx.db.get(partyBrewId));
    expect(party!.items.map((i) => i.contributorKey)).toEqual([toKey, toKey]);
    expect(party!.cauldron![0].brewedByKey).toBe(toKey);
    expect(party!.cauldron![0].witnesses).toEqual([toKey]);
  });

  it("strips deprecated fields (contributorName, provenance, giftEvents, owners) and converts pinned to {perfumeId}", async () => {
    const t = convexTest({ schema, modules });
    const key = "user:solo";
    await plantMember(t, key, "solo");

    const brewId = await t.run(async (ctx) =>
      ctx.db.insert("perfumeBrews", {
        owner: key,
        nickname: null,
        seq: 1,
        items: [
          { key: PURE_N, real: true, contributorKey: key, contributorName: "solo" },
        ],
        strikePlays: [],
        wildPlays: [],
        pinned: { perfumeId: "base:black-gas", recipeIndex: 0 },
        cauldron: [
          {
            instanceId: "inst:c",
            perfumeId: "base:black-gas",
            count: 1,
            brewedByKey: key,
            witnesses: [],
            brewedAt: 1,
            provenance: [{ key, at: 1 }],
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const invId = await t.run(async (ctx) =>
      ctx.db.insert("perfumeInventories", {
        memberKey: key,
        ingredients: {},
        pures: {},
        giftEvents: [
          { itemKey: PURE_N, n: 1, fromKey: "x", toKey: key, at: 1 },
        ],
        perfumes: [
          {
            instanceId: "inst:p",
            perfumeId: "base:black-gas",
            brewedByKey: key,
            witnesses: [],
            brewedAt: 1,
            owners: [{ key, at: 1 }],
          },
        ],
        updatedAt: 1,
      }),
    );

    await t.mutation(internal.perfumeMigration.migrate, {});

    const brew = await t.run(async (ctx) => ctx.db.get(brewId));
    expect(brew!.items[0].contributorName).toBeUndefined();
    expect(brew!.cauldron![0].provenance).toBeUndefined();
    expect(brew!.pinned).toEqual({ perfumeId: "base:black-gas" });
    expect(brew!.pinned!.recipeIndex).toBeUndefined();

    const inv = await t.run(async (ctx) => ctx.db.get(invId));
    expect(inv!.giftEvents).toBeUndefined();
    expect(inv!.perfumes[0].owners).toBeUndefined();
  });

  it("is idempotent: a second run changes nothing and reports zero work", async () => {
    const t = convexTest({ schema, modules });
    const fromKey = "anon:dupe";
    const toKey = "user:real";
    await plantMember(t, fromKey, "tom");
    await plantMember(t, toKey, "tom");
    await t.run(async (ctx) => {
      await ctx.db.insert("perfumeInventories", {
        memberKey: fromKey,
        ingredients: { [ICHOR]: 1 },
        pures: {},
        perfumes: [],
        updatedAt: 1,
      });
    });
    const brewId = await t.run(async (ctx) =>
      ctx.db.insert("perfumeBrews", {
        owner: fromKey,
        nickname: null,
        seq: 1,
        items: [{ key: PURE_N, real: true, contributorKey: fromKey, contributorName: "tom" }],
        strikePlays: [],
        wildPlays: [],
        pinned: { perfumeId: "base:black-gas", recipeIndex: 0 },
        cauldron: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    const first = await t.mutation(internal.perfumeMigration.migrate, {
      mergeMembers: [{ fromKey, toKey }],
    });
    expect(first.mergedPairs).toBe(1);
    expect(first.strippedBrews).toBeGreaterThan(0);

    // Snapshot the whole DB after the first run.
    const snap = async () =>
      await t.run(async (ctx) => ({
        members: await ctx.db.query("perfumeMembers").collect(),
        brews: await ctx.db.query("perfumeBrews").collect(),
        inventories: await ctx.db.query("perfumeInventories").collect(),
      }));
    const before = await snap();

    // Second run: reports no work and leaves the data byte-for-byte identical.
    const second = await t.mutation(internal.perfumeMigration.migrate, {
      mergeMembers: [{ fromKey, toKey }],
    });
    expect(second).toEqual({
      mergedPairs: 0,
      strippedBrews: 0,
      strippedInventories: 0,
    });
    const after = await snap();
    expect(after).toEqual(before);

    // Spot-check the merged end state survived unchanged.
    const brew = await t.run(async (ctx) => ctx.db.get(brewId));
    expect(brew!.owner).toBe(toKey);
    expect(brew!.items[0].contributorKey).toBe(toKey);
    expect(brew!.items[0].contributorName).toBeUndefined();
    expect(brew!.pinned).toEqual({ perfumeId: "base:black-gas" });
    expect((await inventoryOf(t, toKey))!.ingredients[ICHOR]).toBe(1);
  });
});
