// Permission matrix (P1–P4) and conservation (I1–I5) for the Perfumer's Bench
// backend — see app/perfume/DESIGN.md "Backend" and "Testing".

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const ANON_A = "anon:11111111-1111-4111-8111-111111111111";
const PURE_N = "pure:N";
const PURE_STRIKE = "pure:strike";
const ICHOR = "base:Ichorberries"; // emits N, En
const BLACK_GAS = "base:black-gas"; // recipes [["N"]]

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

describe("perfume bench permissions", () => {
  it("P1: non-owner brewPerfume/takeOutput/importInventory/transfer rejected", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.perfume.ensureBench, {});
    await bob.mutation(api.perfume.ensureBench, {});

    const rows = [{ itemKey: PURE_N, count: 1 }];
    await expect(
      bob.mutation(api.perfume.brewPerfume, {
        benchKey: aliceKey,
        perfumeKey: BLACK_GAS,
        recipeIndex: 0,
        k: 1,
      }),
    ).rejects.toThrow(/owner/);
    await expect(
      bob.mutation(api.perfume.takeOutput, {
        benchKey: aliceKey,
        perfumeKey: BLACK_GAS,
        n: 1,
      }),
    ).rejects.toThrow(/owner/);
    await expect(
      bob.mutation(api.perfume.importInventory, {
        benchKey: aliceKey,
        rows,
        mode: "merge",
      }),
    ).rejects.toThrow(/owner/);
    await expect(
      bob.mutation(api.perfume.transfer, {
        benchKey: aliceKey,
        toOwnerKey: bobKey,
        itemKey: PURE_N,
        n: 1,
      }),
    ).rejects.toThrow(/owner/);

    // Anonymous callers are non-owners of a user bench too.
    await expect(
      t.mutation(api.perfume.importInventory, {
        benchKey: aliceKey,
        rows,
        mode: "merge",
        anonId: ANON_A,
      }),
    ).rejects.toThrow(/owner/);

    // No identity at all (neither login nor anonId) is rejected outright.
    await expect(
      t.mutation(api.perfume.moveToBrew, {
        benchKey: aliceKey,
        itemKey: PURE_N,
        n: 1,
      }),
    ).rejects.toThrow(/anonId/);
  });

  it("P2: non-owner CAN move items and play strikes/wilds; updateUI works but pins rejected", async () => {
    const { alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.perfume.ensureBench, {});
    await alice.mutation(api.perfume.importInventory, {
      benchKey: aliceKey,
      rows: [
        { itemKey: PURE_N, count: 2 },
        { itemKey: PURE_STRIKE, count: 1 },
      ],
      mode: "merge",
    });

    // Bob moves ALICE's items into her brew — her inventory changes.
    await bob.mutation(api.perfume.moveToBrew, {
      benchKey: aliceKey,
      itemKey: PURE_N,
      n: 1,
    });
    await bob.mutation(api.perfume.moveToBrew, {
      benchKey: aliceKey,
      itemKey: PURE_STRIKE,
      n: 1,
    });
    let snap = await bob.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(snap.pot).toHaveLength(2);
    expect(snap.pot.every((p) => p.real && p.contributorKey === aliceKey)).toBe(true);
    expect(snap.inventory.pures[PURE_N]).toBe(1);

    // Plays are open but capped by the pot's granted charges (1 ⊖, 0 ⊕).
    await bob.mutation(api.perfume.playStrike, { benchKey: aliceKey, freq: "N" });
    await bob.mutation(api.perfume.playStrike, { benchKey: aliceKey, freq: "En" });
    await bob.mutation(api.perfume.playWild, { benchKey: aliceKey, freq: "A" });
    snap = await bob.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(snap.strikePlays).toEqual(["N"]);
    expect(snap.wildPlays).toEqual([]);
    await bob.mutation(api.perfume.unplayStrike, { benchKey: aliceKey, freq: "N" });

    // Bob moves the item back — and his own (bench-less) inventory is untouched.
    await bob.mutation(api.perfume.moveToInventory, {
      benchKey: aliceKey,
      itemKey: PURE_N,
      n: 1,
    });
    snap = await bob.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(snap.inventory.pures[PURE_N]).toBe(2);
    expect(snap.strikePlays).toEqual([]);
    const bobSnap = await bob.query(api.perfume.getBench, { benchKey: bobKey });
    expect(bobSnap.inventory).toEqual({ ingredients: {}, pures: {}, perfumes: {} });

    // Shared browse UI is writable by anyone; pins are owner-only.
    await bob.mutation(api.perfume.updateUI, {
      benchKey: aliceKey,
      patch: { inputSearch: "rose" },
    });
    snap = await bob.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(snap.ui.inputSearch).toBe("rose");
    await expect(
      bob.mutation(api.perfume.updateUI, {
        benchKey: aliceKey,
        patch: { pins: [BLACK_GAS] },
      }),
    ).rejects.toThrow(/owner/);
    await alice.mutation(api.perfume.updateUI, {
      benchKey: aliceKey,
      patch: { pins: [BLACK_GAS] },
    });
    snap = await alice.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(snap.ui.pins).toEqual([BLACK_GAS]);
  });

  it("P3: party mutations accept anon callers; partyClear rejects non-Tom", async () => {
    const { t, tom, alice } = await setup();
    await t.mutation(api.perfume.ensureBench, { anonId: ANON_A });
    await t.mutation(api.perfume.importInventory, {
      benchKey: ANON_A,
      rows: [{ itemKey: PURE_N, count: 2 }],
      mode: "merge",
      anonId: ANON_A,
    });

    await t.mutation(api.perfume.partyMoveToBrew, {
      itemKey: PURE_N,
      n: 2,
      anonId: ANON_A,
    });
    let party = await t.query(api.perfume.getParty, {});
    expect(party.pot).toHaveLength(2);
    expect(party.pot.every((p) => p.real && p.contributorKey === ANON_A)).toBe(true);

    await t.mutation(api.perfume.partyBrew, {
      perfumeKey: BLACK_GAS,
      recipeIndex: 0,
      k: 2,
      anonId: ANON_A,
    });
    party = await t.query(api.perfume.getParty, {});
    expect(party.pot).toEqual([]);
    expect(party.outputTray[BLACK_GAS]).toBe(2);

    // The take credits the CALLER's bench.
    await t.mutation(api.perfume.partyTake, {
      perfumeKey: BLACK_GAS,
      n: 1,
      anonId: ANON_A,
    });
    const anonBench = await t.query(api.perfume.getBench, { benchKey: ANON_A });
    expect(anonBench.inventory.perfumes[BLACK_GAS]).toBe(1);

    await expect(
      alice.mutation(api.perfume.partyClear, {}),
    ).rejects.toThrow(/Tom/);
    await expect(
      t.mutation(api.perfume.partyClear, { anonId: ANON_A }),
    ).rejects.toThrow(/Tom/);
    await tom.mutation(api.perfume.partyClear, {});
  });

  it("P4: listBenches contains no anon benches", async () => {
    const { t, alice, aliceKey } = await setup();
    await alice.mutation(api.perfume.ensureBench, {});
    await t.mutation(api.perfume.ensureBench, { anonId: ANON_A });

    const benches = await t.query(api.perfume.listBenches, {});
    expect(benches[0].benchKey).toBe("party");
    expect(benches.some((b) => b.benchKey === aliceKey)).toBe(true);
    expect(benches.some((b) => b.benchKey.startsWith("anon:"))).toBe(false);
  });
});

describe("perfume bench invariants", () => {
  it("I1: item totals are conserved across a random op sequence", async () => {
    const { t, tom, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.perfume.ensureBench, {});
    await bob.mutation(api.perfume.ensureBench, {});
    await alice.mutation(api.perfume.importInventory, {
      benchKey: aliceKey,
      rows: [
        { itemKey: PURE_N, count: 3 },
        { itemKey: ICHOR, count: 2 },
      ],
      mode: "merge",
    });
    await bob.mutation(api.perfume.importInventory, {
      benchKey: bobKey,
      rows: [
        { itemKey: PURE_N, count: 1 },
        { itemKey: ICHOR, count: 1 },
      ],
      mode: "merge",
    });

    // Every real copy of `key`, wherever it lives: bench inventories, bench
    // pots, output trays, and the party pot. Hypotheticals count as nothing.
    const total = (key: string) =>
      t.run(async (ctx) => {
        let sum = 0;
        for (const bench of await ctx.db.query("perfumeBenches").collect()) {
          for (const section of ["ingredients", "pures", "perfumes"] as const) {
            sum += bench.inventory[section][key] ?? 0;
          }
          sum += bench.pot.filter((p) => p.key === key && p.real).length;
          sum += bench.outputTray[key] ?? 0;
        }
        const party = await ctx.db.query("perfumePartyBrew").first();
        if (party) {
          sum += party.items.filter((p) => p.key === key && p.real).length;
          sum += party.outputTray[key] ?? 0;
        }
        return sum;
      });

    const ops: (() => Promise<unknown>)[] = [
      () => bob.mutation(api.perfume.moveToBrew, { benchKey: aliceKey, itemKey: PURE_N, n: 1 }),
      () => alice.mutation(api.perfume.moveToBrew, { benchKey: aliceKey, itemKey: ICHOR, n: 1 }),
      () => alice.mutation(api.perfume.moveToInventory, { benchKey: aliceKey, itemKey: PURE_N, n: 2 }),
      () => bob.mutation(api.perfume.moveToInventory, { benchKey: aliceKey, itemKey: ICHOR, n: 1 }),
      () => alice.mutation(api.perfume.partyMoveToBrew, { itemKey: PURE_N, n: 1 }),
      () => bob.mutation(api.perfume.partyMoveToBrew, { itemKey: ICHOR, n: 1 }),
      () => t.mutation(api.perfume.partyMoveToBrew, { itemKey: PURE_N, n: 1, anonId: ANON_A }),
      () => bob.mutation(api.perfume.partyMoveToInventory, { itemKey: PURE_N, n: 1 }),
      () => alice.mutation(api.perfume.partyMoveToInventory, { itemKey: ICHOR, n: 2 }),
      // Transfer rejects when the sender lacks stock — an expected outcome
      // mid-sequence, and one that must leave totals untouched.
      () =>
        alice
          .mutation(api.perfume.transfer, { benchKey: aliceKey, toOwnerKey: bobKey, itemKey: PURE_N, n: 1 })
          .catch(() => undefined),
      () => tom.mutation(api.perfume.partyClear, {}),
    ];

    const before = { n: await total(PURE_N), ichor: await total(ICHOR) };
    expect(before).toEqual({ n: 4, ichor: 3 });
    // Deterministic LCG so failures reproduce.
    let seed = 0xbeef;
    const next = () => (seed = (seed * 1103515245 + 12345) >>> 0);
    for (let i = 0; i < 40; i++) {
      await ops[next() % ops.length]();
      expect(await total(PURE_N)).toBe(before.n);
      expect(await total(ICHOR)).toBe(before.ichor);
    }
  });

  it("I2: party removal credits the contributor", async () => {
    const { t, alice, bob, aliceKey } = await setup();
    await alice.mutation(api.perfume.ensureBench, {});
    await bob.mutation(api.perfume.ensureBench, {});
    await alice.mutation(api.perfume.importInventory, {
      benchKey: aliceKey,
      rows: [{ itemKey: PURE_N, count: 1 }],
      mode: "merge",
    });

    await alice.mutation(api.perfume.partyMoveToBrew, { itemKey: PURE_N, n: 1 });
    let aliceSnap = await t.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(aliceSnap.inventory.pures[PURE_N]).toBeUndefined();

    // Bob pulls Alice's contribution out — it returns to ALICE, not Bob.
    await bob.mutation(api.perfume.partyMoveToInventory, { itemKey: PURE_N, n: 1 });
    aliceSnap = await t.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(aliceSnap.inventory.pures[PURE_N]).toBe(1);
    const party = await t.query(api.perfume.getParty, {});
    expect(party.pot).toEqual([]);
  });

  it("I3: hypotheticals never brewable; they convert only via owner stock", async () => {
    const { t, alice, bob, aliceKey } = await setup();
    await alice.mutation(api.perfume.ensureBench, {});

    // Beyond stock (Alice owns nothing yet) the copy enters as a hypothetical.
    await bob.mutation(api.perfume.moveToBrew, {
      benchKey: aliceKey,
      itemKey: PURE_N,
      n: 1,
    });
    let snap = await t.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(snap.pot).toEqual([
      { key: PURE_N, contributorKey: aliceKey, contributorName: "alice", real: false },
    ]);
    await expect(
      alice.mutation(api.perfume.brewPerfume, {
        benchKey: aliceKey,
        perfumeKey: BLACK_GAS,
        recipeIndex: 0,
        k: 1,
      }),
    ).rejects.toThrow(/hypothetical/);

    // Removal simply deletes a hypothetical — nothing returns to inventory.
    await bob.mutation(api.perfume.moveToInventory, {
      benchKey: aliceKey,
      itemKey: PURE_N,
      n: 1,
    });
    snap = await t.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(snap.pot).toEqual([]);
    expect(snap.inventory.pures[PURE_N]).toBeUndefined();

    // Re-add the hypothetical, then let owner stock convert it: the move
    // spends the stock flipping the existing hypothetical instead of stacking
    // a second copy.
    await bob.mutation(api.perfume.moveToBrew, { benchKey: aliceKey, itemKey: PURE_N, n: 1 });
    await alice.mutation(api.perfume.importInventory, {
      benchKey: aliceKey,
      rows: [{ itemKey: PURE_N, count: 1 }],
      mode: "merge",
    });
    await alice.mutation(api.perfume.moveToBrew, { benchKey: aliceKey, itemKey: PURE_N, n: 1 });
    snap = await t.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(snap.pot).toEqual([
      { key: PURE_N, contributorKey: aliceKey, contributorName: "alice", real: true },
    ]);
    expect(snap.inventory.pures[PURE_N]).toBeUndefined();

    await alice.mutation(api.perfume.brewPerfume, {
      benchKey: aliceKey,
      perfumeKey: BLACK_GAS,
      recipeIndex: 0,
      k: 1,
    });
    snap = await t.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(snap.pot).toEqual([]);
    expect(snap.outputTray[BLACK_GAS]).toBe(1);

    // Every mutation appended an event row for the bench.
    const actions = await t.run(async (ctx) =>
      (await ctx.db.query("perfumeEvents").collect())
        .filter((e) => e.benchKey === aliceKey)
        .map((e) => e.action),
    );
    expect(actions).toContain("moveToBrew");
    expect(actions).toContain("brewPerfume");
  });

  it("I4: takeOutput caps at available; a second take-all gets nothing", async () => {
    const { alice, aliceKey } = await setup();
    await alice.mutation(api.perfume.ensureBench, {});
    await alice.mutation(api.perfume.importInventory, {
      benchKey: aliceKey,
      rows: [{ itemKey: PURE_N, count: 2 }],
      mode: "merge",
    });
    await alice.mutation(api.perfume.moveToBrew, { benchKey: aliceKey, itemKey: PURE_N, n: 2 });
    // 2× the {N} recipe brews k=2 copies (engine-verified server-side).
    await alice.mutation(api.perfume.brewPerfume, {
      benchKey: aliceKey,
      perfumeKey: BLACK_GAS,
      recipeIndex: 0,
      k: 2,
    });

    const first = await alice.mutation(api.perfume.takeOutput, {
      benchKey: aliceKey,
      perfumeKey: BLACK_GAS,
      n: 5,
    });
    expect(first.taken).toBe(2);
    const second = await alice.mutation(api.perfume.takeOutput, {
      benchKey: aliceKey,
      perfumeKey: BLACK_GAS,
      n: 5,
    });
    expect(second.taken).toBe(0);
    const snap = await alice.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(snap.outputTray[BLACK_GAS]).toBeUndefined();
    expect(snap.inventory.perfumes[BLACK_GAS]).toBe(2);
  });

  it("brewPerfume re-verifies with the engine: a mismatched tally is rejected", async () => {
    const { alice, aliceKey } = await setup();
    await alice.mutation(api.perfume.ensureBench, {});
    await alice.mutation(api.perfume.importInventory, {
      benchKey: aliceKey,
      rows: [{ itemKey: PURE_N, count: 1 }],
      mode: "merge",
    });
    await alice.mutation(api.perfume.moveToBrew, { benchKey: aliceKey, itemKey: PURE_N, n: 1 });
    // 1×{N} is not 2×{N}: the owner asking for k=2 must fail the engine check.
    await expect(
      alice.mutation(api.perfume.brewPerfume, {
        benchKey: aliceKey,
        perfumeKey: BLACK_GAS,
        recipeIndex: 0,
        k: 2,
      }),
    ).rejects.toThrow(/does not brew/);
    // The failed brew consumed nothing.
    const snap = await alice.query(api.perfume.getBench, { benchKey: aliceKey });
    expect(snap.pot).toHaveLength(1);
    expect(snap.outputTray[BLACK_GAS]).toBeUndefined();
  });

  it("I5: transfer conserves the pair's sum and rejects sending items you lack", async () => {
    const { t, alice, bob, aliceKey, bobKey } = await setup();
    await alice.mutation(api.perfume.ensureBench, {});
    await bob.mutation(api.perfume.ensureBench, {});
    await alice.mutation(api.perfume.importInventory, {
      benchKey: aliceKey,
      rows: [{ itemKey: PURE_N, count: 3 }],
      mode: "merge",
    });

    await alice.mutation(api.perfume.transfer, {
      benchKey: aliceKey,
      toOwnerKey: bobKey,
      itemKey: PURE_N,
      n: 2,
    });
    let aliceSnap = await t.query(api.perfume.getBench, { benchKey: aliceKey });
    let bobSnap = await t.query(api.perfume.getBench, { benchKey: bobKey });
    expect(aliceSnap.inventory.pures[PURE_N]).toBe(1);
    expect(bobSnap.inventory.pures[PURE_N]).toBe(2);

    await expect(
      alice.mutation(api.perfume.transfer, {
        benchKey: aliceKey,
        toOwnerKey: bobKey,
        itemKey: PURE_N,
        n: 5,
      }),
    ).rejects.toThrow(/Not enough/);
    aliceSnap = await t.query(api.perfume.getBench, { benchKey: aliceKey });
    bobSnap = await t.query(api.perfume.getBench, { benchKey: bobKey });
    expect(
      (aliceSnap.inventory.pures[PURE_N] ?? 0) + (bobSnap.inventory.pures[PURE_N] ?? 0),
    ).toBe(3);
  });

  it("presence: upserts by (benchKey, clientId), lists only fresh rows, sweeps stale ones", async () => {
    const { t, alice, aliceKey } = await setup();
    const cursor = (clientId: string) => ({
      benchKey: aliceKey,
      clientId,
      name: clientId,
      color: "#fff",
      surface: "stage" as const,
      x: 50,
      y: 50,
    });
    await alice.mutation(api.perfume.presenceUpdate, cursor("a"));
    await alice.mutation(api.perfume.presenceUpdate, cursor("b"));
    await alice.mutation(api.perfume.presenceUpdate, cursor("a"));
    let rows = await t.query(api.perfume.presenceList, { benchKey: aliceKey });
    expect(rows.map((r) => r.clientId).sort()).toEqual(["a", "b"]);

    // Age "a" past the 10s freshness window: listed no more; past 15s the next
    // presenceUpdate for the bench sweeps the row entirely.
    await t.run(async (ctx) => {
      const stale = (await ctx.db.query("perfumePresence").collect()).find(
        (r) => r.clientId === "a",
      )!;
      await ctx.db.patch(stale._id, { updatedAt: Date.now() - 16_000 });
    });
    rows = await t.query(api.perfume.presenceList, { benchKey: aliceKey });
    expect(rows.map((r) => r.clientId)).toEqual(["b"]);
    await alice.mutation(api.perfume.presenceUpdate, cursor("b"));
    const remaining = await t.run(async (ctx) =>
      (await ctx.db.query("perfumePresence").collect()).map((r) => r.clientId),
    );
    expect(remaining).toEqual(["b"]);
  });
});
