// Multi-brew /perfume backend suite — the full DESIGN.md §§1–9 contract:
// the permission matrix (§4), rules of brewing (§3), the three brew-scale
// controls (§5), gifting (§5), per-member undo/redo (§5), copyBrew,
// nickname-by-anyone, deleteBrew (owner/admin), and idempotent + faithful
// migration (§9). Mirrors the harness/utilities of convex/perfume.test.ts.

import { Blob as NodeBlob } from "node:buffer";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

type Harness = TestConvex<typeof schema>;

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// ── fixtures (concrete engine-verified data from app/perfume/data/base.json) ──
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

// getBrew now tolerates bad ids by returning null (deep-link crash guard); every
// test here fetches a KNOWN-good brew, so this wrapper asserts non-null and hands
// back the doc, keeping the assertions terse.
async function getBrewDoc(
  who: { query: Harness["query"] },
  args: { brewId: string },
) {
  const brew = await who.query(api.brews.getBrew, args);
  expect(brew).not.toBeNull();
  return brew!;
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
      cauldron: [],
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

// ── deep-link resolution (DESIGN.md §4 — every brew has a shareable URL) ──────

describe("registration", () => {
  it("registering ensures the party brew exists", async () => {
    const { alice } = await setup();
    expect(await alice.query(api.brews.getPartyBrew, {})).toBeNull();
    await alice.mutation(api.brews.registerMember, {});
    const party = await alice.query(api.brews.getPartyBrew, {});
    expect(party).not.toBeNull();
    expect(party!.owner).toBeNull();
  });
});

describe("getBrew tolerates bad deep links (no crash)", () => {
  it("returns null for a malformed id string instead of throwing", async () => {
    const { alice } = await setup();
    // a syntactically invalid convex id — normalizeId rejects it → null
    const brew = await alice.query(api.brews.getBrew, { brewId: "junk-id" });
    expect(brew).toBeNull();
  });

  it("returns null for a well-formed id that points at no brew", async () => {
    const { t, alice } = await setup();
    // mint a real brew id, delete the row, then look it up: normalizeId accepts
    // the shape but db.get finds nothing → null (a stale/deleted deep link)
    await alice.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await t.run(async (ctx) => ctx.db.delete(brewId));
    const brew = await alice.query(api.brews.getBrew, { brewId });
    expect(brew).toBeNull();
  });

  it("returns the doc for a real id", async () => {
    const { alice } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    const brew = await getBrewDoc(alice, { brewId });
    expect(String(brew._id)).toBe(String(brewId));
  });
});

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
    let brew = await getBrewDoc(alice,{ brewId });
    expect(brew.items).toHaveLength(1);
    expect(brew.items[0].real).toBe(true);

    // Non-owner's add is hypothetical; Alice's stock is untouched.
    await bob.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    brew = await getBrewDoc(bob,{ brewId });
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
    let brew = await getBrewDoc(bob,{ brewId });
    expect(brew.strikePlays).toHaveLength(1);
    expect(brew.strikePlays[0].freq).toBe("N");
    expect(brew.strikePlays[0].byMemberKey).toBe(bobKey);
    await bob.mutation(api.brews.unplayStrike, { brewId, freq: "N" });
    brew = await getBrewDoc(bob,{ brewId });
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
    const brew = await getBrewDoc(alice,{ brewId: party });
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
    const after = await getBrewDoc(bob,{ brewId: party });
    expect(after.cauldron![0].count).toBe(2);
    await bob.mutation(api.brews.takeFromCauldron, { brewId: party, instanceId });
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

  it("a visitor (not logged in) is rejected — membership is login-only", async () => {
    const { t, alice } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // `t` with no identity models a logged-out visitor: no auth → rejected.
    await expect(
      t.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 }),
    ).rejects.toThrow(/Sign in to join/);
  });

  it("a logged-in user who never joined cannot arrange a brew (must join first)", async () => {
    const { alice, bob } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // Bob is logged in (identity resolves) but never called registerMember, so
    // he is not a member yet.
    await expect(
      bob.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 }),
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
    const brew = await getBrewDoc(tom,{ brewId });
    expect(brew.items[0].real).toBe(true);
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBeUndefined();
    await tom.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 1 });
    expect((await getBrewDoc(tom,{ brewId })).cauldron).toHaveLength(1);
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
    const brew = await getBrewDoc(alice,{ brewId });
    expect(brew.items).toHaveLength(1);
    expect(brew.cauldron).toHaveLength(0);
  });

  it("consumption is permanent: real items become their hypothetical twins, nothing returns", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    await alice.mutation(api.brews.brew, { brewId, perfumeId: BLACK_GAS, recipeIndex: 0, k: 1 });

    const brew = await getBrewDoc(alice,{ brewId });
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
    const brew = await getBrewDoc(alice,{ brewId });
    expect(brew.cauldron).toHaveLength(1);
    expect(brew.cauldron![0].count).toBe(3);
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
    const brew = await getBrewDoc(alice,{ brewId });
    expect(brew.items[0].real).toBe(true); // untouched
    expect(brew.cauldron).toHaveLength(0);
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
    const brew = await getBrewDoc(alice,{ brewId });
    const output = brew.cauldron!.find((o) => o.instanceId === instanceId)!;
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
    expect((await getBrewDoc(alice,{ brewId })).cauldron).toHaveLength(1);
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
    expect((await getBrewDoc(alice,{ brewId })).cauldron![0].count).toBe(2);
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
    const brew = await getBrewDoc(alice,{ brewId });
    expect(brew.strikePlays).toHaveLength(0);
    expect(brew.wildPlays).toHaveLength(0);
    // A real frequency still plays fine.
    await alice.mutation(api.brews.playStrike, { brewId, freq: "N" });
    expect((await getBrewDoc(alice,{ brewId })).strikePlays).toHaveLength(1);
  });

  it("playing past granted charges is a silent no-op", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // A pure:N grants 0 strike charges — the play is ignored.
    await alice.mutation(api.brews.moveItemToBrew, { brewId, itemKey: PURE_N, n: 1 });
    await alice.mutation(api.brews.playStrike, { brewId, freq: "N" });
    expect((await getBrewDoc(alice,{ brewId })).strikePlays).toHaveLength(0);
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
    expect((await getBrewDoc(alice,{ brewId })).strikePlays).toHaveLength(2);
    // Remove the liver → 0 ⊖ charges remain → both plays trimmed.
    await alice.mutation(api.brews.moveItemToInventory, { brewId, itemKey: SHADOW_LIVER, n: 1 });
    expect((await getBrewDoc(alice,{ brewId })).strikePlays).toHaveLength(0);
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
    const brew = await getBrewDoc(alice,{ brewId });
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
    const brew = await getBrewDoc(alice,{ brewId });
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
    const brew = await getBrewDoc(alice,{ brewId });
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
    expect((await getBrewDoc(alice,{ brewId: party })).items).toHaveLength(0);
  });
});

// ── gifting (DESIGN.md §5 — instant; permanent; provenance) ──────────────────

describe("gifting", () => {
  it("gift a stack: conserves the pair total, moves counts only (no gift history), is instant", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 3 });

    await alice.mutation(api.brews.giftItem, { toMemberKey: bobKey, itemKey: PURE_N, n: 2 });
    const aInv = await alice.query(api.brews.getInventory, { memberKey: aliceKey });
    const bInv = await bob.query(api.brews.getInventory, { memberKey: bobKey });
    // Counts moved; the pair total (3) is conserved. Gifting keeps NO history.
    expect(aInv.pures[PURE_N]).toBe(1);
    expect(bInv.pures[PURE_N]).toBe(2); // arrived instantly — no acceptance step
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

  it("gift a perfume INSTANCE: moves whole, keeping its flat provenance", async () => {
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
    await alice.mutation(api.brews.takeFromCauldron, { brewId, instanceId });
    const inst = (await alice.query(api.brews.getInventory, { memberKey: aliceKey })).perfumes[0];

    await alice.mutation(api.brews.giftPerfume, { toMemberKey: bobKey, instanceId: inst.instanceId });
    // Left Alice, arrived at Bob whole — no ownership chain is extended.
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).perfumes).toHaveLength(0);
    const bobPerfumes = (await bob.query(api.brews.getInventory, { memberKey: bobKey })).perfumes;
    expect(bobPerfumes).toHaveLength(1);
    // Flat provenance ({brewedBy, witnesses}) survives the gift unchanged.
    expect(bobPerfumes[0].brewedByKey).toBe(aliceKey);
    expect(bobPerfumes[0].witnesses).toEqual([]);
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
    expect((await getBrewDoc(alice,{ brewId })).items).toHaveLength(0);
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBe(1);

    await alice.mutation(api.brews.redo, { brewId });
    const brew = await getBrewDoc(alice,{ brewId });
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
    expect((await getBrewDoc(alice,{ brewId })).items).toHaveLength(1);

    // Bob CAN undo his own move.
    expect((await bob.query(api.brews.undoState, { brewId })).canUndo).toBe(true);
    await bob.mutation(api.brews.undo, { brewId });
    expect((await getBrewDoc(alice,{ brewId })).items).toHaveLength(0);
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
    await alice.mutation(api.brews.pinPerfume, { brewId, perfumeId: BLACK_GAS });
    await alice.mutation(api.brews.undo, { brewId });
    expect((await getBrewDoc(alice,{ brewId })).pinned).toBeNull();

    // Strike, then undo the strike.
    await alice.mutation(api.brews.playStrike, { brewId, freq: "En" });
    expect((await getBrewDoc(alice,{ brewId })).strikePlays).toHaveLength(1);
    await alice.mutation(api.brews.undo, { brewId });
    expect((await getBrewDoc(alice,{ brewId })).strikePlays).toHaveLength(0);

    // Wild, then undo the wild.
    await alice.mutation(api.brews.playWild, { brewId, chosenFreq: "A" });
    expect((await getBrewDoc(alice,{ brewId })).wildPlays).toHaveLength(1);
    await alice.mutation(api.brews.undo, { brewId });
    expect((await getBrewDoc(alice,{ brewId })).wildPlays).toHaveLength(0);
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
    await alice.mutation(api.brews.takeFromCauldron, { brewId, instanceId });
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
    await alice.mutation(api.brews.pinPerfume, { brewId: src, perfumeId: BLACK_GAS });

    const copyId = await bob.mutation(api.brews.copyBrew, { brewId: src });
    const copy = await getBrewDoc(bob,{ brewId: copyId });
    // Same item keys, but every copy is hypothetical and credited to Bob.
    expect(copy.owner).toBe(bobKey);
    expect(copy.items).toHaveLength(4);
    expect(copy.items.every((i) => !i.real)).toBe(true);
    expect(copy.items.every((i) => i.contributorKey === bobKey)).toBe(true);
    // Plays and pin carry over, re-attributed to the copier.
    expect(copy.strikePlays).toEqual([{ freq: "N", byMemberKey: bobKey }]);
    expect(copy.pinned).toEqual({ perfumeId: BLACK_GAS });
    // Copying spent none of Alice's stock, and the source is unchanged.
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).ingredients[ICHOR]).toBeUndefined();
    const srcBrew = await getBrewDoc(alice,{ brewId: src });
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
    expect((await getBrewDoc(bob,{ brewId: copyId })).cauldron).toHaveLength(0);
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
    const copy = await getBrewDoc(bob,{ brewId: copyId });
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
    expect((await getBrewDoc(bob,{ brewId: copyId })).seq).toBe(2);
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
    expect((await getBrewDoc(alice,{ brewId })).nickname).toBe("night bloom");
    // Blank clears the nickname.
    await alice.mutation(api.brews.nicknameBrew, { brewId, nickname: "   " });
    expect((await getBrewDoc(alice,{ brewId })).nickname).toBeNull();
  });

  it("pin targets a perfume; pin is an owner-act (DESIGN §4); unknown perfume rejected", async () => {
    const { alice, bob } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    const brewId = await alice.mutation(api.brews.createBrew, {});
    // The owner may pin a perfume on their own brew — stored as {perfumeId}.
    await alice.mutation(api.brews.pinPerfume, { brewId, perfumeId: BLACK_GAS });
    expect((await getBrewDoc(alice,{ brewId })).pinned).toEqual({
      perfumeId: BLACK_GAS,
    });
    // A non-owner may NOT pin someone else's owned brew (WHERE-not-WHAT).
    await expect(
      bob.mutation(api.brews.pinPerfume, { brewId, perfumeId: BLACK_GAS }),
    ).rejects.toThrow(/owner/);
    // An unknown perfume is rejected for the owner.
    await expect(
      alice.mutation(api.brews.pinPerfume, { brewId, perfumeId: "base:nope" }),
    ).rejects.toThrow(/Unknown perfume/);
    // Passing null clears the pin.
    await alice.mutation(api.brews.pinPerfume, { brewId, perfumeId: null });
    expect((await getBrewDoc(alice,{ brewId })).pinned).toBeNull();
  });

  it("default naming: seq increments per owner", async () => {
    const { alice } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    const b1 = await alice.mutation(api.brews.createBrew, {});
    const b2 = await alice.mutation(api.brews.createBrew, {});
    expect((await getBrewDoc(alice,{ brewId: b1 })).seq).toBe(1);
    expect((await getBrewDoc(alice,{ brewId: b2 })).seq).toBe(2);
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
    // Owner deletes their own. getBrew of the now-deleted id resolves to null
    // (a graceful deep-link miss), not a throw.
    const own = await alice.mutation(api.brews.createBrew, {});
    await alice.mutation(api.brews.deleteBrew, { brewId: own });
    expect(await alice.query(api.brews.getBrew, { brewId: own })).toBeNull();
    // Admin deletes Alice's remaining brew.
    await tom.mutation(api.brews.deleteBrew, { brewId });
    expect(await alice.query(api.brews.getBrew, { brewId })).toBeNull();
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
    expect((await getBrewDoc(bob,{ brewId })).owner).toBe(bobKey);
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

// ── importInventory (stock declaration, not a gift) ──────────────────────────

describe("importInventory", () => {
  it("merge adds onto existing stacks; replace clears then declares", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1, [ICHOR]: 5 });

    // Merge: +2 pure:N onto the existing 1 (→3); +1 fresh key; ICHOR untouched.
    await alice.mutation(api.brews.importInventory, {
      mode: "merge",
      rows: [
        { key: PURE_N, count: 2 },
        { key: SHADOW_LIVER, count: 1 },
      ],
    });
    let inv = await alice.query(api.brews.getInventory, { memberKey: aliceKey });
    expect(inv.pures[PURE_N]).toBe(3);
    expect(inv.ingredients[SHADOW_LIVER]).toBe(1);
    expect(inv.ingredients[ICHOR]).toBe(5); // pre-existing stack preserved

    // Replace: the whole stack set is discarded and re-declared from the rows.
    await alice.mutation(api.brews.importInventory, {
      mode: "replace",
      rows: [{ key: ICHOR, count: 4 }],
    });
    inv = await alice.query(api.brews.getInventory, { memberKey: aliceKey });
    expect(inv.ingredients[ICHOR]).toBe(4);
    expect(inv.pures[PURE_N]).toBeUndefined(); // cleared by replace
    expect(inv.ingredients[SHADOW_LIVER]).toBeUndefined();
  });

  it("rejects an unknown item key and a negative count (no partial write)", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await seedStock(t, aliceKey, { [PURE_N]: 1 });
    await expect(
      alice.mutation(api.brews.importInventory, {
        mode: "merge",
        rows: [{ key: "base:not-a-thing", count: 1 }],
      }),
    ).rejects.toThrow(/Unknown item/);
    await expect(
      alice.mutation(api.brews.importInventory, {
        mode: "merge",
        rows: [{ key: PURE_N, count: -3 }],
      }),
    ).rejects.toThrow(/Invalid count/);
    // The rejected imports left the seeded stock exactly as it was.
    expect((await alice.query(api.brews.getInventory, { memberKey: aliceKey })).pures[PURE_N]).toBe(1);
  });

  it("import is a stock declaration — it only writes fungible stacks", async () => {
    const { alice, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await alice.mutation(api.brews.importInventory, {
      mode: "replace",
      rows: [{ key: PURE_N, count: 2 }],
    });
    const inv = await alice.query(api.brews.getInventory, { memberKey: aliceKey });
    expect(inv.pures[PURE_N]).toBe(2);
    // Import touches only the fungible stacks — no perfume instances appear.
    expect(inv.perfumes).toHaveLength(0);
  });

  it("an unregistered caller may not import (owner-only on own inventory)", async () => {
    const { bob } = await setup();
    // Bob is logged in but never joined — not a member, owns no inventory.
    await expect(
      bob.mutation(api.brews.importInventory, {
        mode: "merge",
        rows: [{ key: PURE_N, count: 1 }],
      }),
    ).rejects.toThrow(/Join the party first/);
  });
});

// ── member icon URLs (client can never resolve a storageId) ──────────────────

describe("listMembers iconUrl", () => {
  it("resolves an uploaded icon to a servable url; iconless members carry null", async () => {
    const { t, alice, bob, aliceKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    // Store a blob and attach it to Alice as her icon (bypassing the upload-url
    // round trip the client uses; setMemberIcon persists the storageId). Use
    // node:buffer's Blob — the jsdom test environment's Blob polyfill lacks the
    // arrayBuffer() method convex-test's storage.store hashes the bytes with.
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(
        new NodeBlob(["icon-bytes"], { type: "image/png" }) as unknown as Blob,
      ),
    );
    await alice.mutation(api.brews.setMemberIcon, { storageId });

    const members = await alice.query(api.brews.listMembers, {});
    const a = members.find((m) => m.memberKey === aliceKey)!;
    const b = members.find((m) => m.memberKey !== aliceKey)!;
    expect(a.iconStorageId).not.toBeNull();
    expect(typeof a.iconUrl).toBe("string"); // resolved, not a bare id
    expect(a.iconUrl).not.toBeNull();
    // Bob never uploaded — both the id and the url are null.
    expect(b.iconStorageId).toBeNull();
    expect(b.iconUrl).toBeNull();
  });
});

// ── listAllBrews (see-all — the full per-member list, newest first) ──────────

describe("listAllBrews", () => {
  it("returns ALL of one member's brews, most-recent first (past the top-bar cut)", async () => {
    const { alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.brews.registerMember, {});
    await bob.mutation(api.brews.registerMember, {});
    // Alice owns three brews; Bob owns one (isolation check).
    const a1 = await alice.mutation(api.brews.createBrew, {});
    const a2 = await alice.mutation(api.brews.createBrew, {});
    const a3 = await alice.mutation(api.brews.createBrew, {});
    await bob.mutation(api.brews.createBrew, {});

    // Touch a1 last so it becomes the most-recently-updated of Alice's brews,
    // proving the ordering is by updatedAt (not creation/seq order).
    await alice.mutation(api.brews.nicknameBrew, { brewId: a1, nickname: "revived" });

    const list = await alice.query(api.brews.listAllBrews, { memberKey: aliceKey });
    expect(list).toHaveLength(3); // only Alice's brews, never Bob's or the party
    expect(list.every((b) => b.owner === aliceKey)).toBe(true);
    // Newest-first: a1 (just nicknamed) leads; the rest follow by updatedAt desc.
    expect(list[0].brewId).toBe(a1);
    expect(list[0].nickname).toBe("revived");
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].updatedAt).toBeGreaterThanOrEqual(list[i].updatedAt);
    }
    expect(list.map((b) => b.brewId).sort()).toEqual([a1, a2, a3].sort());

    // Bob's own see-all returns exactly his one brew.
    expect(await alice.query(api.brews.listAllBrews, { memberKey: bobKey })).toHaveLength(1);
  });
});
