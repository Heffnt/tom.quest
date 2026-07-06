// Multi-brew /perfume backend suite — the full DESIGN.md §§1–9 contract:
// the permission matrix (§4), rules of brewing (§3), the three brew-scale
// controls (§5), gifting (§5), per-member undo/redo (§5), copyBrew,
// nickname-by-anyone, deleteBrew (owner/admin), and idempotent + faithful
// migration (§9). Mirrors the harness/utilities of convex/perfume.test.ts.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

type Harness = TestConvex<typeof schema>;

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// ── fixtures (concrete engine-verified data from app/perfume/data/base.json) ──
const ANON_A = "anon:11111111-1111-4111-8111-111111111111";
const PURE_N = "pure:N"; // emits {N}
const PURE_STRIKE = "pure:strike"; // grants 1 ⊖, emits nothing
const PURE_WILD = "pure:wild"; // grants 1 ⊕, emits nothing
const ICHOR = "base:Ichorberries"; // emits {N, En}
const SHADOW_LIVER = "base:Shadow Demon Liver"; // grants 2 ⊖, emits nothing
const BLACK_GAS = "base:black-gas"; // recipes [["N"]] — one N brews it

async function setup() {
  const t = convexTest({ schema, modules });
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  const aliceId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "alice", email: "alice@tom.quest", role: "user" }),
  );
  const bobId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "bob", email: "bob@tom.quest", role: "user" }),
  );
  return {
    t,
    tom: t.withIdentity({ subject: tomId }),
    alice: t.withIdentity({ subject: aliceId }),
    bob: t.withIdentity({ subject: bobId }),
    tomKey: `user:${tomId}`,
    aliceKey: `user:${aliceId}`,
    bobKey: `user:${bobId}`,
  };
}

// Seed a member's fungible stock directly — there is no importInventory in the
// new API yet (a Phase-3 UI concern); mirrors the old suite's inventory writes.
async function seedStock(
  t: Harness,
  memberKey: string,
  stacks: Record<string, number>,
) {
  await t.run(async (ctx) => {
    const inv = await ctx.db
      .query("perfumeInventories")
      .withIndex("by_member", (q) => q.eq("memberKey", memberKey))
      .unique();
    const ingredients: Record<string, number> = {};
    const pures: Record<string, number> = {};
    for (const [k, n] of Object.entries(stacks)) {
      if (k.startsWith("pure:")) pures[k] = n;
      else ingredients[k] = n;
    }
    if (inv) await ctx.db.patch(inv._id, { ingredients, pures });
    else
      await ctx.db.insert("perfumeInventories", {
        memberKey,
        ingredients,
        pures,
        giftEvents: [],
        perfumes: [],
        updatedAt: Date.now(),
      });
  });
}

// The party brew is created on demand by internal helpers the tests cannot call
// directly (heartbeat needs a brewId; nothing else ensures it). Insert it once
// and return its id — the single owner===null row.
async function makePartyBrew(t: Harness) {
  return await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("perfumeBrews")
      .withIndex("by_owner", (q) => q.eq("owner", null))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("perfumeBrews", {
      owner: null,
      nickname: null,
      seq: 0,
      items: [],
      strikePlays: [],
      wildPlays: [],
      pinned: null,
      outputs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

// Force fresh presence for `memberKey` on `brewId` so a subsequent brew records
// them as a witness (heartbeat is the live path; here we plant the row).
async function plantPresence(
  t: Harness,
  brewId: string,
  memberKey: string,
  name: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("perfumeBrewPresence", {
      brewId: brewId as never,
      clientId: `${memberKey}-c`,
      memberKey,
      name,
      color: "#fff",
      surface: "stage",
      x: 1,
      y: 1,
      updatedAt: Date.now(),
    });
  });
}

// ── permission matrix (DESIGN.md §4) ─────────────────────────────────────────

describe("multi-brew permissions matrix", () => {
  it("owner adds REAL from own stock; non-owner adds HYPOTHETICAL only, cannot spend owner stock", async () => {
    const { t, alice, bob, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 2 });
    const brewId = await alice.mutation(api.brews.createBrew, {});

    // Owner draws real.
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    let brew = await alice.query(api.brews.getBrew, { brewId });
    expect(brew.items).toHaveLength(1);
    expect(brew.items[0].real).toBe(true);

    // Non-owner's add is hypothetical; Alice's stock is untouched.
    await bob.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    brew = await bob.query(api.brews.getBrew, { brewId });
    expect(brew.items).toHaveLength(2);
    expect(brew.items.filter((i) => i.real)).toHaveLength(1);
    expect(brew.items.filter((i) => !i.real)).toHaveLength(1);
    const inv = await alice.query(api.brews.getInventory, { memberKey: aliceKey });
    expect(inv.pures[PURE_N]).toBe(1); // only the owner's own move spent stock
  });

  it("non-owner may play/undo strikes & wilds but may NOT brew, take, fill, return, empty, gift, delete", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1, [PURE_STRIKE]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_STRIKE, n: 1 });

    // WHERE actions: Bob (non-owner) may play and unplay a strike; the play is
    // attributed to Bob (byMemberKey), not the owner.
    await bob.mutation(api.brews.playStrike, { brewId, freq: "N" });
    let brew = await bob.query(api.brews.getBrew, { brewId });
    expect(brew.strikePlays).toHaveLength(1);
    expect(brew.strikePlays[0].freq).toBe("N");
    expect(brew.strikePlays[0].byMemberKey).toBe(bobKey);
    await bob.mutation(api.brews.unplayStrike, { brewId, freq: "N" });
    brew = await bob.query(api.brews.getBrew, { brewId });
    expect(brew.strikePlays).toHaveLength(0);

    // WHAT actions are all owner-only and reject the non-owner.
    await expect(
      bob.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 1 }),
    ).rejects.toThrow(/owner/);
    await expect(
      bob.mutation(api.brews.fillFromInventory, { brewId }),
    ).rejects.toThrow(/owner/);
    await expect(
      bob.mutation(api.brews.returnIngredients, { brewId }),
    ).rejects.toThrow(/owner/);
    await expect(
      bob.mutation(api.brews.emptyBrew, { brewId }),
    ).rejects.toThrow(/owner/);
    await expect(
      bob.mutation(api.brews.deleteBrew, { brewId }),
    ).rejects.toThrow(/owner or admin/);
  });

  it("party brew: every member contributes their OWN real stock and may brew/take", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    await seedStock(t, bobKey, { [PURE_N]: 1 });
    const party = await makePartyBrew(t);

    await alice.mutation(api.brews.moveItemToBrew, { brewId: party, itemKey: PURE_N, n: 1 });
    await bob.mutation(api.brews.moveItemToBrew, { brewId: party, itemKey: PURE_N, n: 1 });
    const brew = await alice.query(api.brews.getBrew, { brewId: party });
    expect(brew.items).toHaveLength(2);
    expect(brew.items.every((i) => i.real)).toBe(true);
    // Each item is credited to its own contributor; each spent their own stock.
    expect(brew.items.map((i) => i.contributorKey).sort()).toEqual([aliceKey, bobKey].sort());
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBeUndefined();
    expect((await bob.query(api.brews.getInventory, { memberKey: bobKey })).pures[PURE_N]).toBeUndefined();

    // Bob (a plain member) may brew the party brew and take from its cauldron.
    const { instanceId } = await bob.mutation(api.brews.brew, {
      brewId: party,
      perfumeId: BLACK_GAS,
      recipeIndex: 0,
      k: 2,
    });
    const after = await bob.query(api.brews.getBrew, { brewId: party });
    expect(after.outputs[0].count).toBe(2);
    await bob.mutation(api.brews.takeOutput, { brewId: party, instanceId });
    expect((await bob.query(api.brews.getInventory, { memberKey: bobKey })).perfumes).toHaveLength(1);
  });

  it("inventory isolation: moving another's item never touches the mover's own inventory", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    await seedStock(t, bobKey, { [PURE_N]: 5 });
    const brewId = await alice.mutation(api.brews.createBrew, {});

    // Bob adds a hypothetical to Alice's brew, then removes it.
    await bob.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    await bob.mutation(api.brews.moveItemToInventory, { brewId, itemKey: PURE_N, n: 1 });
    // Bob's own stock is exactly as seeded; Alice's untouched.
    expect((await bob.query(api.brews.getInventory, { memberKey: bobKey })).pures[PURE_N]).toBe(5);
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBe(1);
  });

  it("caller with no identity (no login, no anonId) is rejected", async () => {
    const { t, alice } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await expect(
      t.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 }),
    ).rejects.toThrow(/Sign in or provide anonId/);
  });

  it("a malformed anonId is rejected", async () => {
    const { t, alice } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await expect(
      t.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1, anonId: "anon:not-a-uuid" }),
    ).rejects.toThrow(/Malformed anonId/);
  });

  it("an unregistered caller cannot arrange a brew (must join first)", async () => {
    const { t, alice } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // A well-formed anon who never joined is not a member.
    await expect(
      t.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1, anonId: ANON_A }),
    ).rejects.toThrow(/Join the party first/);
  });

  it("admin (Tom) may draw REAL stock onto another member's brew and brew it", async () => {
    const { t, tom, alice, aliceKey } = await setup();
    await tom.mutation(api.brews.registerMember, {});
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});

    // Admin acts as owner: real stock (drawn from the owner's inventory) and brew.
    await tom.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    const brew = await tom.query(api.brews.getBrew, { brewId });
    expect(brew.items[0].real).toBe(true);
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBeUndefined();
    await tom.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 1 });
    expect((await tom.query(api.brews.getBrew, { brewId })).outputs).toHaveLength(1);
  });
});

// ── rules of brewing (DESIGN.md §3) ──────────────────────────────────────────

describe("rules of brewing", () => {
  it("a single hypothetical blocks brewing (names the blocker)", async () => {
    const { alice, bob } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // Bob adds a hypothetical (owns no stock to draw from).
    await bob.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    await expect(
      alice.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 1 }),
    ).rejects.toThrow(/hypothetical/);
    // Nothing consumed, no output.
    const brew = await alice.query(api.brews.getBrew, { brewId });
    expect(brew.items).toHaveLength(1);
    expect(brew.outputs).toHaveLength(0);
  });

  it("consumption is permanent: real items become their hypothetical twins, nothing returns", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    await alice.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 1 });

    const brew = await alice.query(api.brews.getBrew, { brewId });
    // The graph is left in place but every item is now a hypothetical twin.
    expect(brew.items).toHaveLength(1);
    expect(brew.items[0].real).toBe(false);
    expect(brew.items[0].key).toBe(PURE_N);
    // No stock returned — consumption is forever.
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBeUndefined();
  });

  it("k-multiples: a tally of k× the recipe brews exactly k outputs (engine-derived)", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 3 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 3 });

    // 3×{N} is k=3; asking for the wrong k is rejected by the engine check.
    await expect(
      alice.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 2 }),
    ).rejects.toThrow(/does not brew/);
    await alice.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 3 });
    const brew = await alice.query(api.brews.getBrew, { brewId });
    expect(brew.outputs).toHaveLength(1);
    expect(brew.outputs[0].count).toBe(3);
  });

  it("a mismatched tally is rejected by the engine (no consumption)", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [ICHOR]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // Ichorberries emits {N, En}; black-gas wants {N} — the En excess is off.
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: ICHOR, n: 1 });
    await expect(
      alice.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 1 }),
    ).rejects.toThrow(/does not brew/);
    const brew = await alice.query(api.brews.getBrew, { brewId });
    expect(brew.items[0].real).toBe(true); // untouched
    expect(brew.outputs).toHaveLength(0);
  });

  it("witnesses are captured from fresh presence at completion", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    // Both Alice and Bob are present on the brew at completion.
    await plantPresence(t, brewId, aliceKey, "alice");
    await plantPresence(t, brewId, bobKey, "bob");

    const { instanceId } = await alice.mutation(api.brews.brew, {
      brewId,
      perfumeId: BLACK_GAS,
      recipeIndex: 0,
      k: 1,
    });
    const brew = await alice.query(api.brews.getBrew, { brewId });
    const output = brew.outputs.find((o) => o.instanceId === instanceId)!;
    expect(output.brewedByKey).toBe(aliceKey);
    expect([...output.witnesses].sort()).toEqual([aliceKey, bobKey].sort());
  });

  it("strikes and wilds shape the tally the engine verifies", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    // Ichor emits {N, En}; a strike on En leaves {N} — black-gas at k=1.
    await seedStock(t, aliceKey, { [ICHOR]: 1, [PURE_STRIKE]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: ICHOR, n: 1 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_STRIKE, n: 1 });
    await alice.mutation(api.brews.playStrike, { brewId, freq: "En" });
    await alice.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 1 });
    expect((await alice.query(api.brews.getBrew, { brewId })).outputs).toHaveLength(1);
  });

  it("a wild adds a frequency that lifts a brew to a k-multiple", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    // {N} + a pure wild chosen as N = {N,N} → 2× black-gas.
    await seedStock(t, aliceKey, { [PURE_N]: 1, [PURE_WILD]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_WILD, n: 1 });
    await alice.mutation(api.brews.playWild, { brewId, chosenFreq: "N" });
    await alice.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 2 });
    expect((await alice.query(api.brews.getBrew, { brewId })).outputs[0].count).toBe(2);
  });

  it("playStrike/playWild reject an unknown frequency id (no junk in shared tally)", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [ICHOR]: 1, [SHADOW_LIVER]: 1, [PURE_WILD]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: ICHOR, n: 1 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: SHADOW_LIVER, n: 1 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_WILD, n: 1 });
    // Junk freq ids are rejected before any charge is consumed.
    await expect(
      alice.mutation(api.brews.playStrike, { brewId, freq: "NOT_A_FREQ" }),
    ).rejects.toThrow(/Unknown frequency/);
    await expect(
      alice.mutation(api.brews.playWild, { brewId, chosenFreq: "garbage" }),
    ).rejects.toThrow(/Unknown frequency/);
    const brew = await alice.query(api.brews.getBrew, { brewId });
    expect(brew.strikePlays).toHaveLength(0);
    expect(brew.wildPlays).toHaveLength(0);
    // A real frequency still plays fine.
    await alice.mutation(api.brews.playStrike, { brewId, freq: "N" });
    expect((await alice.query(api.brews.getBrew, { brewId })).strikePlays).toHaveLength(1);
  });

  it("playing past granted charges is a silent no-op", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // A pure:N grants 0 strike charges — the play is ignored.
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    await alice.mutation(api.brews.playStrike, { brewId, freq: "N" });
    expect((await alice.query(api.brews.getBrew, { brewId })).strikePlays).toHaveLength(0);
  });

  it("removing an ingredient trims plays that its charges no longer support", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [ICHOR]: 1, [SHADOW_LIVER]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: ICHOR, n: 1 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: SHADOW_LIVER, n: 1 });
    // Shadow Demon Liver grants 2 ⊖; play two strikes.
    await alice.mutation(api.brews.playStrike, { brewId, freq: "N" });
    await alice.mutation(api.brews.playStrike, { brewId, freq: "En" });
    expect((await alice.query(api.brews.getBrew, { brewId })).strikePlays).toHaveLength(2);
    // Remove the liver → 0 ⊖ charges remain → both plays trimmed.
    await alice.mutation(api.brews.moveItemToInventory, { brewId, itemKey: SHADOW_LIVER, n: 1 });
    expect((await alice.query(api.brews.getBrew, { brewId })).strikePlays).toHaveLength(0);
  });
});

// ── brew-scale controls (DESIGN.md §5) ───────────────────────────────────────

describe("brew-scale controls", () => {
  it("fillFromInventory converts hypotheticals real, drawing from the owner's stock", async () => {
    const { t, alice, bob, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // Bob seeds two hypotheticals; Alice then gains stock for only one.
    await bob.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 2 });
    await seedStock(t, aliceKey, { [PURE_N]: 1 });

    const { filled } = await alice.mutation(api.brews.fillFromInventory, { brewId });
    expect(filled).toBe(1);
    const brew = await alice.query(api.brews.getBrew, { brewId });
    expect(brew.items.filter((i) => i.real)).toHaveLength(1);
    expect(brew.items.filter((i) => !i.real)).toHaveLength(1);
    // Stock spent.
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBeUndefined();
  });

  it("returnIngredients returns REAL items to contributors and leaves hypotheticals", async () => {
    const { t, alice, bob, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 }); // real
    await bob.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 }); // hypothetical

    await alice.mutation(api.brews.returnIngredients, { brewId });
    const brew = await alice.query(api.brews.getBrew, { brewId });
    // The real item left; the hypothetical remains.
    expect(brew.items).toHaveLength(1);
    expect(brew.items[0].real).toBe(false);
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBe(1);
  });

  it("emptyBrew clears everything and returns real items to contributors (conservation)", async () => {
    const { t, alice, bob, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1, [PURE_STRIKE]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_STRIKE, n: 1 });
    await bob.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 }); // hypothetical

    await alice.mutation(api.brews.emptyBrew, { brewId });
    const brew = await alice.query(api.brews.getBrew, { brewId });
    expect(brew.items).toHaveLength(0);
    expect(brew.strikePlays).toHaveLength(0);
    // Alice's two real items came back; Bob's hypothetical was destroyed (owned no stock).
    const aInv = await alice.query(api.brews.getInventory, { memberKey: aliceKey });
    expect(aInv.pures[PURE_N]).toBe(1);
    expect(aInv.pures[PURE_STRIKE]).toBe(1);
  });

  it("party emptyBrew returns each contributor's real items home", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    await seedStock(t, bobKey, { [PURE_N]: 1 });
    const party = await makePartyBrew(t);
    await alice.mutation(api.brews.moveItemToBrew, { brewId: party, itemKey: PURE_N, n: 1 });
    await bob.mutation(api.brews.moveItemToBrew, { brewId: party, itemKey: PURE_N, n: 1 });

    // Any member may empty the party brew; each contributor is credited back.
    await bob.mutation(api.brews.emptyBrew, { brewId: party });
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBe(1);
    expect((await bob.query(api.brews.getInventory, { memberKey: bobKey })).pures[PURE_N]).toBe(1);
    expect((await alice.query(api.brews.getBrew, { brewId: party })).items).toHaveLength(0);
  });
});

// ── gifting (DESIGN.md §5 — instant; permanent; provenance) ──────────────────

describe("gifting", () => {
  it("gift a stack: conserves the pair total, records a gift event on both sides, is instant", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 3 });

    await alice.mutation(api.brews.giftItem, { toMemberKey: bobKey, itemKey: PURE_N, n: 2 });
    const aInv = await alice.query(api.brews.getInventory, { memberKey: aliceKey });
    const bInv = await bob.query(api.brews.getInventory, { memberKey: bobKey });
    expect(aInv.pures[PURE_N]).toBe(1);
    expect(bInv.pures[PURE_N]).toBe(2); // arrived instantly — no acceptance step
    // The event is recorded on both inventories' append-only history.
    expect(aInv.giftEvents).toHaveLength(1);
    expect(bInv.giftEvents).toHaveLength(1);
    expect(aInv.giftEvents[0]).toMatchObject({ itemKey: PURE_N, n: 2, fromKey: aliceKey, toKey: bobKey });
  });

  it("gift rejects over-send and self-gift (no clamping)", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    await expect(
      alice.mutation(api.brews.giftItem, { toMemberKey: bobKey, itemKey: PURE_N, n: 5 }),
    ).rejects.toThrow(/Not enough/);
    await expect(
      alice.mutation(api.brews.giftItem, { toMemberKey: aliceKey, itemKey: PURE_N, n: 1 }),
    ).rejects.toThrow(/yourself/);
  });

  it("gift a perfume INSTANCE: moves whole and extends the owner chain", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    const { instanceId } = await alice.mutation(api.brews.brew, {
      brewId,
      perfumeId: BLACK_GAS,
      recipeIndex: 0,
      k: 1,
    });
    await alice.mutation(api.brews.takeOutput, { brewId, instanceId });
    const inst = (await alice.query(api.brews.getInventory, { memberKey: aliceKey })).perfumes[0];

    await alice.mutation(api.brews.giftPerfume, { toMemberKey: bobKey, instanceId: inst.instanceId });
    // Left Alice, arrived at Bob whole; Bob's owner chain now ends with Bob.
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).perfumes).toHaveLength(0);
    const bobPerfumes = (await bob.query(api.brews.getInventory, { memberKey: bobKey })).perfumes;
    expect(bobPerfumes).toHaveLength(1);
    expect(bobPerfumes[0].owners[bobPerfumes[0].owners.length - 1].key).toBe(bobKey);
    // brewedBy provenance survives the gift.
    expect(bobPerfumes[0].brewedByKey).toBe(aliceKey);
  });

  it("gifting is permanent — it is never written to the undo log", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 2 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.giftItem, { toMemberKey: bobKey, itemKey: PURE_N, n: 1 });
    // No undo entry exists for the gift (giftItem is keyed off no brew), and an
    // unrelated brew's undo is empty for Alice.
    const undo = await alice.query(api.brews.undoState, { brewId });
    expect(undo.canUndo).toBe(false);
  });
});

// ── undo / redo (DESIGN.md §5 — per-member isolation, bounded, brew not undoable) ──

describe("undo / redo", () => {
  it("undo reverses the caller's own move; redo replays it", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });

    await alice.mutation(api.brews.undo, { brewId });
    expect((await alice.query(api.brews.getBrew, { brewId })).items).toHaveLength(0);
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBe(1);

    await alice.mutation(api.brews.redo, { brewId });
    const brew = await alice.query(api.brews.getBrew, { brewId });
    expect(brew.items).toHaveLength(1);
    expect(brew.items[0].real).toBe(true);
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBeUndefined();
  });

  it("per-member isolation: A cannot undo B's move", async () => {
    const { t, alice, bob, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // Bob moves a hypothetical onto Alice's brew.
    await bob.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });

    // Alice has nothing of her own to undo — her undo is a no-op; Bob's item stays.
    expect((await alice.query(api.brews.undoState, { brewId })).canUndo).toBe(false);
    const r = await alice.mutation(api.brews.undo, { brewId });
    expect(r.undone).toBe(false);
    expect((await alice.query(api.brews.getBrew, { brewId })).items).toHaveLength(1);

    // Bob CAN undo his own move.
    expect((await bob.query(api.brews.undoState, { brewId })).canUndo).toBe(true);
    await bob.mutation(api.brews.undo, { brewId });
    expect((await alice.query(api.brews.getBrew, { brewId })).items).toHaveLength(0);
  });

  it("undo/redo covers strike, wild, and pin actions", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_STRIKE]: 1, [ICHOR]: 1, [PURE_WILD]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: ICHOR, n: 1 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_STRIKE, n: 1 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_WILD, n: 1 });

    // Pin, then undo the pin.
    await alice.mutation(api.brews.pinRecipe, { brewId, pinned: { perfumeId: BLACK_GAS, recipeIndex: 0 } });
    await alice.mutation(api.brews.undo, { brewId });
    expect((await alice.query(api.brews.getBrew, { brewId })).pinned).toBeNull();

    // Strike, then undo the strike.
    await alice.mutation(api.brews.playStrike, { brewId, freq: "En" });
    expect((await alice.query(api.brews.getBrew, { brewId })).strikePlays).toHaveLength(1);
    await alice.mutation(api.brews.undo, { brewId });
    expect((await alice.query(api.brews.getBrew, { brewId })).strikePlays).toHaveLength(0);

    // Wild, then undo the wild.
    await alice.mutation(api.brews.playWild, { brewId, chosenFreq: "A" });
    expect((await alice.query(api.brews.getBrew, { brewId })).wildPlays).toHaveLength(1);
    await alice.mutation(api.brews.undo, { brewId });
    expect((await alice.query(api.brews.getBrew, { brewId })).wildPlays).toHaveLength(0);
  });

  it("brewing is NOT undoable (no entry written; undo stack untouched)", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    // Undo the move so the undo stack is empty of redoable/undoable entries.
    await alice.mutation(api.brews.undo, { brewId });
    await alice.mutation(api.brews.redo, { brewId }); // back to 1 real item, stack: [move done]
    await alice.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 1 });

    // The only undoable entry is still the move — brewing added none.
    const entries = await t.run(async (ctx) =>
      ctx.db
        .query("perfumeUndo")
        .withIndex("by_brew_member", (q) => q.eq("brewId", brewId as never).eq("memberKey", aliceKey))
        .collect(),
    );
    expect(entries.map((e) => e.action)).toEqual(["move"]);
  });

  it("taking is NOT undoable", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    const { instanceId } = await alice.mutation(api.brews.brew, {
      brewId,
      perfumeId: BLACK_GAS,
      recipeIndex: 0,
      k: 1,
    });
    await alice.mutation(api.brews.takeOutput, { brewId, instanceId });
    const entries = await t.run(async (ctx) =>
      ctx.db
        .query("perfumeUndo")
        .withIndex("by_brew_member", (q) => q.eq("brewId", brewId as never).eq("memberKey", aliceKey))
        .collect(),
    );
    // Only the move was ever undoable; take wrote nothing.
    expect(entries.every((e) => e.action === "move")).toBe(true);
  });

  it("a fresh forward action invalidates the redo stack", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 2 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    await alice.mutation(api.brews.undo, { brewId }); // redo available
    expect((await alice.query(api.brews.undoState, { brewId })).canRedo).toBe(true);
    // A new move discards the redoable entry.
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    expect((await alice.query(api.brews.undoState, { brewId })).canRedo).toBe(false);
  });

  it("the undo log is bounded (~50 per brew/member)", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // 60 hypothetical moves (Alice owns no stock — each move logs an undo entry).
    for (let i = 0; i < 60; i++) {
      await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    }
    const count = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("perfumeUndo")
          .withIndex("by_brew_member", (q) => q.eq("brewId", brewId as never).eq("memberKey", aliceKey))
          .collect()
      ).length,
    );
    expect(count).toBeLessThanOrEqual(50);
  });
});

// ── copyBrew (DESIGN.md §4 — all-hypothetical) ───────────────────────────────

describe("copyBrew", () => {
  it("copies contents as ALL hypothetical into a fresh brew the copier owns", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 2, [ICHOR]: 1, [SHADOW_LIVER]: 1 });
    const src = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId: src, itemKey: PURE_N, n: 2 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId: src, itemKey: ICHOR, n: 1 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId: src, itemKey: SHADOW_LIVER, n: 1 });
    await alice.mutation(api.brews.playStrike, { brewId: src, freq: "N" });
    await alice.mutation(api.brews.pinRecipe, { brewId: src, pinned: { perfumeId: BLACK_GAS, recipeIndex: 0 } });

    const copyId = await bob.mutation(api.brews.copyBrew, { brewId: src });
    const copy = await bob.query(api.brews.getBrew, { brewId: copyId });
    // Same item keys, but every copy is hypothetical and credited to Bob.
    expect(copy.owner).toBe(bobKey);
    expect(copy.items).toHaveLength(4);
    expect(copy.items.every((i) => !i.real)).toBe(true);
    expect(copy.items.every((i) => i.contributorKey === bobKey)).toBe(true);
    // Plays and pin carry over, re-attributed to the copier.
    expect(copy.strikePlays).toEqual([{ freq: "N", byMemberKey: bobKey }]);
    expect(copy.pinned).toEqual({ perfumeId: BLACK_GAS, recipeIndex: 0 });
    // Copying spent none of Alice's stock, and the source is unchanged.
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).ingredients[ICHOR]).toBeUndefined();
    const srcBrew = await alice.query(api.brews.getBrew, { brewId: src });
    expect(srcBrew.items.filter((i) => i.real).length).toBeGreaterThan(0);
  });

  it("copy carries no outputs — the cauldron belongs to the source", async () => {
    const { t, alice, bob, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const src = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId: src, itemKey: PURE_N, n: 1 });
    await alice.mutation(api.brews.brew, { brewId: src, perfumeId: BLACK_GAS, recipeIndex: 0, k: 1 });

    const copyId = await bob.mutation(api.brews.copyBrew, { brewId: src });
    expect((await bob.query(api.brews.getBrew, { brewId: copyId })).outputs).toHaveLength(0);
  });

  it("drops junk-frequency plays from the source and trims to the copy's charge budget", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [ICHOR]: 1, [SHADOW_LIVER]: 1 });
    const src = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId: src, itemKey: ICHOR, n: 1 });
    await alice.mutation(api.brews.moveItemToBrew, { brewId: src, itemKey: SHADOW_LIVER, n: 1 });
    // Corrupt the source directly with a junk strike play (the play API now
    // rejects junk, so plant it to model a pre-existing corrupted brew).
    await t.run(async (ctx) => {
      await ctx.db.patch(src as never, {
        strikePlays: [
          { freq: "N", byMemberKey: aliceKey },
          { freq: "JUNK", byMemberKey: aliceKey },
        ],
      });
    });
    const copyId = await bob.mutation(api.brews.copyBrew, { brewId: src });
    const copy = await bob.query(api.brews.getBrew, { brewId: copyId });
    // The junk play is gone; the valid one carries over, re-attributed to Bob.
    expect(copy.strikePlays).toEqual([{ freq: "N", byMemberKey: bobKey }]);
  });

  it("the copier gets a fresh per-owner seq", async () => {
    const { alice, bob } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    const src = await alice.mutation(api.brews.createBrew, {});
    await bob.mutation(api.brews.createBrew, {}); // Bob's brew 1
    const copyId = await bob.mutation(api.brews.copyBrew, { brewId: src });
    expect((await bob.query(api.brews.getBrew, { brewId: copyId })).seq).toBe(2);
  });
});

// ── nickname (DESIGN.md §4 — by anyone) & pin ────────────────────────────────

describe("nickname & pin", () => {
  it("any member may nickname any brew; blank clears back to default", async () => {
    const { alice, bob } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // Bob (not the owner) may nickname Alice's brew.
    await bob.mutation(api.brews.nicknameBrew, { brewId, nickname: "night bloom" });
    expect((await alice.query(api.brews.getBrew, { brewId })).nickname).toBe("night bloom");
    // Blank clears the nickname.
    await alice.mutation(api.brews.nicknameBrew, { brewId, nickname: "   " });
    expect((await alice.query(api.brews.getBrew, { brewId })).nickname).toBeNull();
  });

  it("pin validates the perfume and recipe index; any member may pin", async () => {
    const { alice, bob } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await bob.mutation(api.brews.pinRecipe, { brewId, pinned: { perfumeId: BLACK_GAS, recipeIndex: 0 } });
    expect((await alice.query(api.brews.getBrew, { brewId })).pinned).toEqual({
      perfumeId: BLACK_GAS,
      recipeIndex: 0,
    });
    await expect(
      bob.mutation(api.brews.pinRecipe, { brewId, pinned: { perfumeId: BLACK_GAS, recipeIndex: 9 } }),
    ).rejects.toThrow(/recipe index/);
    await expect(
      bob.mutation(api.brews.pinRecipe, { brewId, pinned: { perfumeId: "base:nope", recipeIndex: 0 } }),
    ).rejects.toThrow(/Unknown perfume/);
  });

  it("default naming: seq increments per owner", async () => {
    const { alice } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    const b1 = await alice.mutation(api.brews.createBrew, {});
    const b2 = await alice.mutation(api.brews.createBrew, {});
    expect((await alice.query(api.brews.getBrew, { brewId: b1 })).seq).toBe(1);
    expect((await alice.query(api.brews.getBrew, { brewId: b2 })).seq).toBe(2);
  });
});

// ── deleteBrew / member removal (DESIGN.md §4 — owner or admin) ───────────────

describe("deleteBrew & member removal", () => {
  it("owner may delete their own brew; a stranger may not; admin may delete any", async () => {
    const { tom, alice, bob } = await setup();
    await tom.mutation(api.brews.registerMember, {});
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});

    await expect(bob.mutation(api.brews.deleteBrew, { brewId })).rejects.toThrow(/owner or admin/);
    // Owner deletes their own.
    const own = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.deleteBrew, { brewId: own });
    await expect(alice.query(api.brews.getBrew, { brewId: own })).rejects.toThrow(/not found/);
    // Admin deletes Alice's remaining brew.
    await tom.mutation(api.brews.deleteBrew, { brewId });
    await expect(alice.query(api.brews.getBrew, { brewId })).rejects.toThrow(/not found/);
  });

  it("deleteBrew cascades to undo & presence rows", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 }); // logs undo
    await plantPresence(t, brewId, aliceKey, "alice");
    await alice.mutation(api.brews.deleteBrew, { brewId });
    const leftovers = await t.run(async (ctx) => ({
      undo: (await ctx.db.query("perfumeUndo").collect()).length,
      presence: (await ctx.db.query("perfumeBrewPresence").collect()).length,
    }));
    expect(leftovers).toEqual({ undo: 0, presence: 0 });
  });

  it("admin removes a member: their member row, owned brews, and inventory go", async () => {
    const { t, tom, alice, aliceKey } = await setup();
    await tom.mutation(api.brews.registerMember, {});
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    await alice.mutation(api.brews.createBrew, {});

    await tom.mutation(api.brews.removeMember, { memberKey: aliceKey });
    const state = await t.run(async (ctx) => ({
      member: await ctx.db.query("perfumeMembers").withIndex("by_member", (q) => q.eq("memberKey", aliceKey)).unique(),
      brews: (await ctx.db.query("perfumeBrews").withIndex("by_owner", (q) => q.eq("owner", aliceKey)).collect()).length,
      inv: await ctx.db.query("perfumeInventories").withIndex("by_member", (q) => q.eq("memberKey", aliceKey)).unique(),
    }));
    expect(state.member).toBeNull();
    expect(state.brews).toBe(0);
    expect(state.inv).toBeNull();
  });

  it("a non-admin may not remove another member", async () => {
    const { alice, bob, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await expect(
      alice.mutation(api.brews.removeMember, { memberKey: bobKey }),
    ).rejects.toThrow(/admin/);
  });

  it("a member may remove THEMSELVES (leaveParty)", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.leaveParty, {});
    const member = await t.run(async (ctx) =>
      ctx.db.query("perfumeMembers").withIndex("by_member", (q) => q.eq("memberKey", aliceKey)).unique(),
    );
    expect(member).toBeNull();
  });
});

// ── handoff (DESIGN.md §4 — explicit ownership move) ─────────────────────────

describe("handoff", () => {
  it("owner hands a brew to another member; ownership travels", async () => {
    const { alice, bob, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.handoffBrew, { brewId, toMemberKey: bobKey });
    expect((await bob.query(api.brews.getBrew, { brewId })).owner).toBe(bobKey);
  });

  it("a non-owner cannot hand off; the party brew has no owner to hand off", async () => {
    const { t, alice, bob, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await expect(
      bob.mutation(api.brews.handoffBrew, { brewId, toMemberKey: aliceKey }),
    ).rejects.toThrow(/owner/);
    const party = await makePartyBrew(t);
    await expect(
      alice.mutation(api.brews.handoffBrew, { brewId: party, toMemberKey: aliceKey }),
    ).rejects.toThrow(/no owner/);
  });
});

// ── presence (DESIGN.md §9 — bounded per member/brew) ────────────────────────

describe("presence", () => {
  it("a flood of unique clientIds cannot grow one member's presence unboundedly", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // 50 heartbeats each with a fresh clientId, all inside the sweep window
    // (none stale) — the per-member cap must keep the row count bounded.
    for (let i = 0; i < 50; i++) {
      await alice.mutation(api.brews.heartbeat, {
        brewId,
        clientId: `flood-${i}`,
        color: "#fff",
        surface: "stage",
        x: i,
        y: i,
      });
    }
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("perfumeBrewPresence")
        .withIndex("by_brew", (q) => q.eq("brewId", brewId as never))
        .collect(),
    );
    const mine = rows.filter((r) => r.memberKey === aliceKey);
    expect(mine.length).toBeLessThanOrEqual(4);
    // A stable clientId keeps updating its own single row (no growth).
    for (let i = 0; i < 5; i++) {
      await alice.mutation(api.brews.heartbeat, {
        brewId,
        clientId: "stable",
        color: "#fff",
        surface: "stage",
        x: i,
        y: i,
      });
    }
    const after = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("perfumeBrewPresence")
          .withIndex("by_brew", (q) => q.eq("brewId", brewId as never))
          .collect()
      ).filter((r) => r.clientId === "stable"),
    );
    expect(after).toHaveLength(1);
  });
});

// ── migration (DESIGN.md §9 — idempotent + faithful) ─────────────────────────

describe("migration", () => {
  // Seed one old bench with a pot item, a strike play, a wild play, ingredient
  // + pure + perfume inventory, and an output tray — every field the spec maps.
  async function seedBench(t: Harness, ownerKey: string) {
    await t.run(async (ctx) => {
      await ctx.db.insert("perfumeBenches", {
        ownerKey,
        ownerName: "alice",
        color: "#abc123",
        pot: [
          { key: PURE_N, contributorKey: ownerKey, contributorName: "alice", real: true },
          { key: ICHOR, contributorKey: ownerKey, contributorName: "alice", real: false },
        ],
        strikePlays: ["N"],
        wildPlays: ["A"],
        inventory: {
          ingredients: { [ICHOR]: 2 },
          pures: { [PURE_N]: 3 },
          perfumes: { [BLACK_GAS]: 2 },
        },
        outputTray: { [BLACK_GAS]: 4 },
        ui: {
          inputTab: "ingredients",
          inputSearch: "",
          inputFilters: [],
          perfumeSearch: "",
          perfumeFilters: [],
          expanded: [],
          pins: [],
        },
        updatedAt: 123,
      });
    });
  }

  it("carries every bench field to where the spec says (fidelity)", async () => {
    const t = convexTest({ schema, modules });
    const aliceId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "alice", email: "a@x", role: "user" }),
    );
    const aliceKey = `user:${aliceId}`;
    await seedBench(t, aliceKey);

    const r = await t.mutation(internal.brews.migrateBenchesToBrews, {});
    expect(r.membersCreated).toBe(1);
    expect(r.brewsCreated).toBe(1);

    // Member row: name + color carried.
    const member = await t.run(async (ctx) =>
      ctx.db.query("perfumeMembers").withIndex("by_member", (q) => q.eq("memberKey", aliceKey)).unique(),
    );
    expect(member?.name).toBe("alice");
    expect(member?.color).toBe("#abc123");

    // Inventory: fungible stacks carried; perfume stack (2) expanded to 2 instances.
    const inv = await t.query(api.brews.getInventory, { memberKey: aliceKey });
    expect(inv.ingredients[ICHOR]).toBe(2);
    expect(inv.pures[PURE_N]).toBe(3);
    expect(inv.perfumes).toHaveLength(2);
    expect(inv.perfumes.every((p) => p.perfumeId === BLACK_GAS && p.brewedByKey === aliceKey)).toBe(true);

    // Brew 1: pot → items (real flags preserved), plays wrapped with byMemberKey,
    // output tray → output instance with count.
    const brews = await t.run(async (ctx) =>
      ctx.db.query("perfumeBrews").withIndex("by_owner", (q) => q.eq("owner", aliceKey)).collect(),
    );
    expect(brews).toHaveLength(1);
    const brew = brews[0];
    expect(brew.seq).toBe(1);
    expect(brew.items).toHaveLength(2);
    expect(brew.items.find((i) => i.key === PURE_N)?.real).toBe(true);
    expect(brew.items.find((i) => i.key === ICHOR)?.real).toBe(false);
    expect(brew.strikePlays).toEqual([{ freq: "N", byMemberKey: aliceKey }]);
    expect(brew.wildPlays).toEqual([{ chosenFreq: "A", byMemberKey: aliceKey }]);
    expect(brew.outputs).toHaveLength(1);
    expect(brew.outputs[0]).toMatchObject({ perfumeId: BLACK_GAS, count: 4, brewedByKey: aliceKey });
  });

  it("migrates the old party pot into the party brew", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("perfumePartyBrew", {
        items: [{ key: PURE_N, contributorKey: "anon:x", contributorName: "vis", real: true }],
        strikePlays: [],
        wildPlays: [],
        outputTray: { [BLACK_GAS]: 1 },
        updatedAt: 55,
      });
    });
    await t.mutation(internal.brews.migrateBenchesToBrews, {});
    const party = await t.query(api.brews.getPartyBrew, {});
    expect(party?.owner).toBeNull();
    expect(party?.items).toHaveLength(1);
    expect(party?.outputs[0]).toMatchObject({ perfumeId: BLACK_GAS, count: 1 });
  });

  it("is idempotent: running twice yields the same result (no duplicates)", async () => {
    const t = convexTest({ schema, modules });
    const aliceId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "alice", email: "a@x", role: "user" }),
    );
    const aliceKey = `user:${aliceId}`;
    await seedBench(t, aliceKey);

    const r1 = await t.mutation(internal.brews.migrateBenchesToBrews, {});
    expect(r1).toEqual({ membersCreated: 1, brewsCreated: 1 });

    // Snapshot the resulting tables.
    const snap = async () =>
      t.run(async (ctx) => ({
        members: (await ctx.db.query("perfumeMembers").collect()).length,
        brews: (await ctx.db.query("perfumeBrews").collect()).length,
        invPerfumes: (
          await ctx.db.query("perfumeInventories").withIndex("by_member", (q) => q.eq("memberKey", aliceKey)).unique()
        )?.perfumes.length,
      }));
    const after1 = await snap();

    const r2 = await t.mutation(internal.brews.migrateBenchesToBrews, {});
    expect(r2).toEqual({ membersCreated: 0, brewsCreated: 0 });
    const after2 = await snap();
    expect(after2).toEqual(after1); // no new members/brews; perfumes not re-expanded
  });
});
