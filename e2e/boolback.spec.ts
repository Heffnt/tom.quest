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

  // Default is all-averaged; if an averaged dimension is offered, splitting it
  // is a one-click action that reveals the "split" section.
  const avgSplit = page.getByRole("button", { name: /split .* would explain/i }).first();
  if (await avgSplit.count()) {
    await avgSplit.click();
    await expect(page.getByText("split", { exact: true }).first()).toBeVisible();
  }
});
