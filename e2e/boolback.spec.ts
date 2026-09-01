import { expect, test } from "@playwright/test";

// /boolback falls back to the bundled sample snapshot when Turing is
// unreachable (data/source.ts), so these run without the cluster. The plot
// rework renamed Chart → Plot and added Group Plot + the dimension board.

test("view switcher shows the renamed Plot / Group Plot tabs", async ({ page }) => {
  await page.goto("/boolback");
  for (const name of ["Table", "Plot", "Group Plot", "Anatomy"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible({ timeout: 30_000 });
  }
});

test("Plot view renders the plot and dimension board", async ({ page }) => {
  await page.goto("/boolback");
  const plot = page.getByRole("button", { name: "Plot", exact: true });
  await expect(plot).toBeVisible({ timeout: 30_000 });
  await plot.click();

  // The pure-SVG plot mounts…
  await expect(page.locator("svg[role=img]").first()).toBeVisible();
  // …and the dimension board's footer toggles (band + ghosts) are present.
  await expect(page.getByText("band", { exact: true })).toBeVisible();
  await expect(page.getByText("ghosts", { exact: true })).toBeVisible();

  // NO SPLIT ASSERTION HERE, on purpose. This spec used to click a "split …
  // would explain …" button and then look for a "split" section, guarded by
  // `if (await avgSplit.count())`. The Split-by editor was removed when layers
  // replaced in-layer splits (app/boolback/components/plot-panel.tsx:36), so
  // nothing in app/ has matched that name since; the guard was always false and
  // the block never ran, which made the spec report a pass for behaviour it had
  // stopped exercising. Split coverage now lives in unit tests, which assert the
  // real state of things rather than skipping: config-panel.test.tsx "no split
  // UI — the removed Split-by editor never renders" asserts the control is gone,
  // and aggregate.test.ts covers the grouping maths the removed control drove.
});
