// Playwright suite for the Perfumer (DESIGN.md, "Testing"): U1–U6 and U9 run
// single-user against ?local=1&seed=basic (the local brew store, no Convex
// traffic); U7/U8 are two-context live-sync specs gated behind E2E_CONVEX=1
// because they mutate the real shared deployment.

import { expect, test } from "@playwright/test";
import {
  APHASIA,
  BLACK_GAS,
  PEAT,
  ROSES,
  SERUM,
  arcNode,
  catalogRow,
  dragOver,
  freqFloats,
  handGhost,
  invSlot,
  openLocalBrew,
  pressAndDrag,
  stage,
} from "./helpers/perfume";

// A cold `next dev` compiles /perfume while every worker's first goto is in
// flight, and dev-mode HMR can full-reload pages mid-test during that churn —
// retries (against a by-then warm server) absorb it deterministically.
test.describe.configure({ retries: 2, timeout: 60_000 });

test.describe("perfume brew — local mode", () => {
  // the hand grammar needs the three-column (lg) layout: panels side by side
  test.skip(
    ({ viewport }) => !!viewport && viewport.width < 1024,
    "needs the wide three-column layout",
  );

  test("U1: boundary commit — frequencies join the brew before release", async ({
    page,
  }) => {
    await openLocalBrew(page);
    await pressAndDrag(page, invSlot(page, ROSES), stage(page));

    // still holding the button: entry into the cauldron already committed the
    // stack IN PLACE (DESIGN.md §3) — its frequencies float, the stock is down
    // one, and the committed copy already stands as an ingredient node
    await expect(freqFloats(page, "A")).toHaveCount(2);
    await expect(invSlot(page, ROSES)).toHaveAttribute(
      "title",
      "Noble Roses ×2 — 1 in the brew",
    );
    await expect(handGhost(page)).toHaveAttribute("data-item-key", ROSES);
    // the committed copy sits in the graph the moment it crosses the boundary —
    // it does not wait for release
    await expect(arcNode(page, ROSES)).toBeVisible();

    await page.mouse.up();
    await expect(arcNode(page, ROSES)).toBeVisible();
    await expect(handGhost(page)).toHaveCount(0);
    await expect(freqFloats(page, "A")).toHaveCount(2);
  });

  test("U1: leaving the cauldron before release un-commits", async ({
    page,
  }) => {
    await openLocalBrew(page);
    await pressAndDrag(page, invSlot(page, ROSES), stage(page));
    await expect(freqFloats(page, "A")).toHaveCount(2);

    // carry it back out — the crossing un-commits before any release
    await dragOver(page, invSlot(page, APHASIA));
    await expect(freqFloats(page)).toHaveCount(0);
    await expect(invSlot(page, ROSES)).toHaveAttribute(
      "title",
      "Noble Roses ×3",
    );

    await page.mouse.up();
    await expect(handGhost(page)).toHaveCount(0);
    await expect(arcNode(page, ROSES)).toHaveCount(0);
    await expect(invSlot(page, ROSES)).toHaveAttribute(
      "title",
      "Noble Roses ×3",
    );
  });

  test("U2: native image drag is suppressed on grabbable art", async ({
    page,
  }) => {
    await openLocalBrew(page);
    await invSlot(page, ROSES).click({ modifiers: ["Shift"] });

    // fires a native dragstart on the surface's art and returns whether it was
    // suppressed. The catalog art is behind the Ingredients tab and lazy-loads
    // off-screen, so scroll it into view first (the product keeps loading="lazy"
    // — we don't touch that; we just make the element attached/visible).
    const dragPrevented = (surface: import("@playwright/test").Locator) =>
      surface
        .locator("img")
        .first()
        .evaluate((img) => {
          const ev = new DragEvent("dragstart", {
            bubbles: true,
            cancelable: true,
          });
          img.dispatchEvent(ev);
          return ev.defaultPrevented;
        });

    // an inventory slot and the committed ingredient node are both on-screen
    expect(await dragPrevented(invSlot(page, ROSES))).toBe(true);
    expect(await dragPrevented(arcNode(page, ROSES))).toBe(true);

    // the catalog card lives on the Ingredients tab — scroll its art on-screen
    await page.getByRole("button", { name: "Ingredients", exact: true }).click();
    const card = catalogRow(page, ROSES);
    await expect(card).toBeVisible();
    await card.locator("img").first().scrollIntoViewIfNeeded();
    expect(await dragPrevented(card)).toBe(true);
  });

  test("U3: in-brew items ghost their icons in the panel", async ({ page }) => {
    await openLocalBrew(page);
    await invSlot(page, ROSES).click({ modifiers: ["Shift"] });
    await invSlot(page, ROSES).click({ modifiers: ["Shift"] });

    // two copies now sit in the brew (as their in-place item nodes, DESIGN.md
    // §3); the inventory slot keeps its place but ghosts its art — "you took
    // the icon" — and its title counts what's left vs. what's in the brew
    const slot = invSlot(page, ROSES);
    await expect(slot).toHaveAttribute("title", "Noble Roses ×1 — 2 in the brew");
    await expect(slot.locator(".opacity-35")).toHaveCount(1);
    await expect(arcNode(page, ROSES)).toHaveAttribute("title", /Noble Roses ×2/);

    // empty-hand right-click on the ghosted slot returns one per click; the
    // ghosting clears once the last copy comes home
    await slot.click({ button: "right" });
    await expect(slot).toHaveAttribute("title", "Noble Roses ×2 — 1 in the brew");
    await slot.click({ button: "right" });
    await expect(slot).toHaveAttribute("title", "Noble Roses ×3");
    await expect(slot.locator(".opacity-35")).toHaveCount(0);
    await expect(arcNode(page, ROSES)).toHaveCount(0);
  });

  test("U4: hover never touches the brew graph", async ({ page }) => {
    // The graph IS the math now (the old brew-bar delta chips are gone); the
    // surviving guarantee is that hovering an input row leaves the graph alone.
    await openLocalBrew(page);
    await invSlot(page, PEAT).click({ modifiers: ["Shift"] });
    await expect(freqFloats(page, "N")).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Brew Black Gas ×2" }),
    ).toBeEnabled();

    // hovering another ingredient row must not conjure or move any graph node
    await invSlot(page, ROSES).hover();
    await expect(freqFloats(page)).toHaveCount(2);
    await expect(freqFloats(page, "A")).toHaveCount(0);
    await expect(arcNode(page, PEAT)).toHaveCount(1);

    // un-hover leaves the graph exactly as it was
    await page.mouse.move(10, 10);
    await expect(freqFloats(page)).toHaveCount(2);
    await expect(arcNode(page, PEAT)).toHaveCount(1);
  });

  test("U5: the hand grammar — click stacking, right-click return, Escape, shift teleports", async ({
    page,
  }) => {
    await openLocalBrew(page);
    const roses = invSlot(page, ROSES);

    // left-click picks up one; repeats on the same stack add one each
    await roses.click();
    await expect(handGhost(page)).toHaveAttribute("data-item-key", ROSES);
    await expect(handGhost(page).getByText("×2")).toHaveCount(0);
    await roses.click();
    await expect(handGhost(page).getByText("×2")).toBeVisible();
    await roses.click();
    await expect(handGhost(page).getByText("×3")).toBeVisible();

    // right-click while holding returns exactly one to the origin
    await roses.click({ button: "right" });
    await expect(handGhost(page).getByText("×2")).toBeVisible();
    await roses.click({ button: "right" });
    await expect(handGhost(page)).toBeVisible();
    await expect(handGhost(page).getByText("×2")).toHaveCount(0);
    await roses.click({ button: "right" });
    await expect(handGhost(page)).toHaveCount(0);
    // pickups and returns never touched the brew
    await expect(roses).toHaveAttribute("title", "Noble Roses ×3");

    // clicking a different item sends the current stack home first
    await roses.click();
    await invSlot(page, APHASIA).click();
    await expect(handGhost(page)).toHaveAttribute("data-item-key", APHASIA);

    // Escape: whole stack home
    await page.keyboard.press("Escape");
    await expect(handGhost(page)).toHaveCount(0);
    await expect(invSlot(page, APHASIA)).toHaveAttribute(
      "title",
      "Aphasia Flower ×2",
    );

    // shift-click teleports one unit: input -> brew, in-brew -> inventory
    await roses.click({ modifiers: ["Shift"] });
    await expect(arcNode(page, ROSES)).toBeVisible();
    await expect(roses).toHaveAttribute(
      "title",
      "Noble Roses ×2 — 1 in the brew",
    );
    // force: the arc nodes drift perpetually, so they are never "stable"
    await arcNode(page, ROSES).click({ modifiers: ["Shift"], force: true });
    await expect(arcNode(page, ROSES)).toHaveCount(0);
    await expect(roses).toHaveAttribute("title", "Noble Roses ×3");
  });

  test("U6: brew flow — brew spawns phials, take to inventory, hypotheticals block with a reason", async ({
    page,
  }) => {
    await openLocalBrew(page);
    await invSlot(page, ROSES).click({ modifiers: ["Shift"] });
    await invSlot(page, APHASIA).click({ modifiers: ["Shift"] });

    const brewSerum = page.getByRole("button", { name: "Brew Swana's Serum" });
    await expect(brewSerum).toBeEnabled();
    await brewSerum.click();

    // brewing spawns the perfume on the cauldron rim…
    const phial = page.locator(
      `[data-testid="output-phial"][data-perfume-key="${SERUM}"]`,
    );
    await expect(phial).toHaveAttribute("aria-label", /Swana's Serum ×1 brewed/);
    // …and does NOT collapse the graph: each consumed real ingredient is left
    // in place as its hypothetical twin (DESIGN.md §3), while its inventory
    // stack is decremented forever (Noble Roses 3 → 2, one of them in-brew)
    await expect(arcNode(page, ROSES)).toHaveAttribute("title", /hypothetical/);
    await expect(invSlot(page, ROSES)).toHaveAttribute(
      "title",
      "Noble Roses ×2 — 1 in the brew",
    );

    // shift-click takes one straight to the inventory's perfume section
    await phial.click({ modifiers: ["Shift"] });
    await expect(phial).toHaveCount(0);
    await expect(invSlot(page, SERUM)).toHaveAttribute(
      "title",
      /Swana's Serum ×1/,
    );

    // clear the hypothetical-twin graph, then build a fresh k-multiple brew
    await page.getByRole("button", { name: "Empty the brew" }).click();
    await expect(arcNode(page, ROSES)).toHaveCount(0);

    // Peat stocks one; a second copy is past stock, so it enters hypothetical
    // and blocks brewing with a named reason
    await invSlot(page, PEAT).click({ modifiers: ["Shift"] });
    await invSlot(page, PEAT).click({ modifiers: ["Shift"] });
    const blocked = page.getByRole("button", { name: "Brew Black Gas ×4" });
    await expect(blocked).toBeDisabled();
    await expect(blocked).toHaveAttribute(
      "title",
      "1× Pemneath Peat is hypothetical",
    );
    await expect(arcNode(page, PEAT)).toHaveAttribute("title", /1 hypothetical/);

    // removing one takes the hypothetical first; the k-multiple brew unblocks
    // (force: the arc nodes drift perpetually, so they are never "stable")
    await arcNode(page, PEAT).click({ button: "right", force: true });
    const brewGas = page.getByRole("button", { name: "Brew Black Gas ×2" });
    await expect(brewGas).toBeEnabled();
    await brewGas.click();
    await expect(
      page.locator(
        `[data-testid="output-phial"][data-perfume-key="${BLACK_GAS}"]`,
      ),
    ).toHaveAttribute("aria-label", /Black Gas ×2 brewed/);
  });

  test("U9: import dialog — exact line, typo → guess → accept, garbage rejected", async ({
    page,
  }) => {
    await openLocalBrew(page);
    await page.getByRole("button", { name: "import" }).click();
    const dialog = page.getByRole("dialog", { name: "Import inventory" });
    await dialog
      .getByRole("textbox")
      .fill("noble roses x3\n2 aphasia flowr\nzzz qqq");

    const rows = dialog.locator("li");
    await expect(rows.nth(0)).toContainText("Noble Roses");
    await expect(rows.nth(0)).toContainText("×3");
    await expect(rows.nth(2)).toContainText("no match");

    // the typo line is not imported as-is: ranked guesses, user accepts
    const guess = rows.nth(1).getByLabel("Possible matches");
    await expect(guess).toHaveValue(APHASIA);
    await rows.nth(1).getByRole("button", { name: "accept" }).click();
    await expect(rows.nth(1)).toContainText("Aphasia Flower");
    await expect(rows.nth(1)).toContainText("×2");

    await expect(dialog.getByText("5 items ready — 1 line skipped")).toBeVisible();
    await dialog.getByRole("button", { name: "Add to inventory" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(invSlot(page, ROSES)).toHaveAttribute("title", "Noble Roses ×6");
    await expect(invSlot(page, APHASIA)).toHaveAttribute(
      "title",
      "Aphasia Flower ×4",
    );
  });
});

// ── U7/U8: two-context live sync (real Convex deployment — opt in) ───────────

test.describe("perfume brew — live sync", () => {
  test.skip(
    !process.env.E2E_CONVEX,
    "set E2E_CONVEX=1 to run the two-context specs (they touch the shared deployment)",
  );
  test.skip(
    ({ viewport }) => !!viewport && viewport.width < 1024,
    "needs the wide three-column layout",
  );

  test("U7/U8: a party contribution appears on another client and returns to its contributor", async ({
    browser,
    baseURL,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    try {
      await a.goto(`${baseURL}/perfume`);
      await b.goto(`${baseURL}/perfume`);
      // anons land on the party tab
      await expect(a.getByRole("button", { name: /Party/ })).toBeVisible({
        timeout: 15_000,
      });

      // A stocks their own inventory (import is a home action — no nickname gate)
      await a.getByRole("button", { name: "import" }).click();
      const importDialog = a.getByRole("dialog", { name: "Import inventory" });
      await importDialog.getByRole("textbox").fill("Noble Roses x1");
      await importDialog
        .getByRole("button", { name: "Add to inventory" })
        .click();
      await expect(invSlot(a, ROSES)).toBeVisible({ timeout: 15_000 });

      // moving it into the party pot is gated on a nickname
      await invSlot(a, ROSES).click({ modifiers: ["Shift"] });
      const promptA = a.getByRole("dialog", { name: "Choose a nickname" });
      await promptA.getByPlaceholder("nickname…").fill("Ada");
      await promptA.getByRole("button", { name: "join in" }).click();
      await expect(arcNode(a, ROSES)).toBeVisible({ timeout: 15_000 });

      // U7: the other client sees the pot move live
      await expect(arcNode(b, ROSES)).toBeVisible({ timeout: 15_000 });

      // U8: anyone may move it out; it returns to the CONTRIBUTOR (A).
      // B's first party mutation is intercepted by the nickname prompt and
      // replayed on save — no second gesture needed.
      await arcNode(b, ROSES).click({ button: "right", force: true });
      const promptB = b.getByRole("dialog", { name: "Choose a nickname" });
      await promptB.getByPlaceholder("nickname…").fill("Bee");
      await promptB.getByRole("button", { name: "join in" }).click();
      await expect(arcNode(b, ROSES)).toHaveCount(0, { timeout: 15_000 });
      await expect(arcNode(a, ROSES)).toHaveCount(0, { timeout: 15_000 });
      await expect(invSlot(a, ROSES)).toHaveAttribute(
        "title",
        "Noble Roses ×1",
        { timeout: 15_000 },
      );
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
