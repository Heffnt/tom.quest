import { describe, it, expect } from "vitest";
import { baseIngredients, basePerfumes, pureIngredients } from "../data/base";
import type { Inventory } from "./brew-types";
import { EMPTY_INVENTORY, inventorySectionFor } from "./brew-types";
import { formatInventory, parseInventoryText } from "./inventory";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ITEM_CATALOG = [...baseIngredients, ...pureIngredients].map((i) => ({
  key: i.key,
  name: i.name,
}));
const FULL_CATALOG = [
  ...ITEM_CATALOG,
  ...basePerfumes.map((p) => ({ key: p.key, name: p.name })),
];

function parseOne(line: string) {
  const rows = parseInventoryText(line, ITEM_CATALOG);
  expect(rows.length).toBe(1);
  return rows[0];
}

// ── 2. Parser tolerance table ────────────────────────────────────────────────

describe("parseInventoryText tolerance", () => {
  const confident: [string, number, string][] = [
    ["3x Noble Roses", 3, "base:Noble Roses"],
    ["Noble Roses x3", 3, "base:Noble Roses"],
    ["noble roses, 3", 3, "base:Noble Roses"],
    ["Noble Roses", 1, "base:Noble Roses"],
    ["NOBLE ROSES X3", 3, "base:Noble Roses"],
    ["Noble Roses × 3", 3, "base:Noble Roses"],
    ["Noble Roses: 3", 3, "base:Noble Roses"],
    ["2 Brightflower", 2, "base:Brightflower"],
    ["Pure Strike x2", 2, "pure:strike"],
    // unambiguous whole-word substrings are confident
    ["Roses x2", 2, "base:Noble Roses"],
    ["peat", 1, "base:Pemneath Peat"],
  ];
  for (const [line, count, itemKey] of confident) {
    it(`"${line}" -> ${count}× ${itemKey}`, () => {
      const row = parseOne(line);
      expect(row.count).toBe(count);
      expect(row.itemKey).toBe(itemKey);
      expect(row.guesses).toEqual([]);
    });
  }

  it("keeps the raw line and skips blank lines", () => {
    const rows = parseInventoryText(
      "\n  \nNoble Roses x3\n\n2x Brightflower\n   \n",
      ITEM_CATALOG,
    );
    expect(rows.map((r) => r.line)).toEqual(["Noble Roses x3", "2x Brightflower"]);
  });

  it("an ambiguous word is not confident ('Pure' matches many names)", () => {
    const row = parseOne("Pure x2");
    expect(row.itemKey).toBeNull();
    expect(row.count).toBe(2);
  });

  it("garbage lines get no key and no guesses", () => {
    for (const line of ["zzzzzz qqqq wwww", "??? !!!", "12"]) {
      const row = parseOne(line);
      expect(row.itemKey, line).toBeNull();
      expect(row.guesses, line).toEqual([]);
    }
  });
});

// ── 3. Guess ranking ─────────────────────────────────────────────────────────

describe("parseInventoryText guesses", () => {
  it('typo "3 noble rose" is not confident; Noble Roses is the first guess', () => {
    const row = parseOne("3 noble rose");
    expect(row.count).toBe(3);
    expect(row.itemKey).toBeNull();
    expect(row.guesses.length).toBeGreaterThan(0);
    expect(row.guesses[0].itemKey).toBe("base:Noble Roses");
    expect(row.guesses[0].name).toBe("Noble Roses");
  });

  it("returns at most 3 guesses, scores descending in (0,1]", () => {
    const row = parseOne("noble rose");
    expect(row.guesses.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < row.guesses.length; i++) {
      expect(row.guesses[i - 1].score).toBeGreaterThanOrEqual(row.guesses[i].score);
    }
    for (const g of row.guesses) {
      expect(g.score).toBeGreaterThan(0);
      expect(g.score).toBeLessThanOrEqual(1);
    }
  });

  it("near-miss single words guess their ingredient (brightflowr)", () => {
    const row = parseOne("2x brightflowr");
    expect(row.itemKey).toBeNull();
    expect(row.guesses[0]?.itemKey).toBe("base:Brightflower");
  });
});

// ── 4. formatInventory + round-trip ──────────────────────────────────────────

describe("formatInventory", () => {
  const inv: Inventory = {
    ingredients: {
      "base:Noble Roses": 3,
      "base:Brightflower": 1,
      "base:Pemneath Peat": 2,
    },
    pures: { "pure:strike": 2, "pure:N": 1 },
    perfumes: { "base:black-gas": 4 },
    perfumeInstances: [],
  };

  it("emits Name xN — ingredients, pures, perfumes, each alphabetical", () => {
    expect(formatInventory(inv, FULL_CATALOG).split("\n")).toEqual([
      "Brightflower x1",
      "Noble Roses x3",
      "Pemneath Peat x2",
      "Pure Necromancy x1",
      "Pure Strike x2",
      "Black Gas x4",
    ]);
  });

  it("skips zero counts and empty sections", () => {
    const sparse: Inventory = {
      ingredients: { "base:Silver": 0 },
      pures: {},
      perfumes: { "base:bright": 1 },
      perfumeInstances: [],
    };
    expect(formatInventory(sparse, FULL_CATALOG)).toBe("Bright x1");
    expect(formatInventory(EMPTY_INVENTORY, FULL_CATALOG)).toBe("");
  });

  it("round-trips through the parser", () => {
    const rows = parseInventoryText(formatInventory(inv, FULL_CATALOG), FULL_CATALOG);
    const perfumeKeys = new Set(basePerfumes.map((p) => p.key));
    const rebuilt: Inventory = {
      ingredients: {},
      pures: {},
      perfumes: {},
      perfumeInstances: [],
    };
    for (const row of rows) {
      expect(row.itemKey, row.line).not.toBeNull();
      const key = row.itemKey!;
      const section = perfumeKeys.has(key) ? "perfumes" : inventorySectionFor(key);
      rebuilt[section][key] = (rebuilt[section][key] || 0) + row.count;
    }
    expect(rebuilt).toEqual(inv);
  });
});
