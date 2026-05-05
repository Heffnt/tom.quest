import { expect, test } from "@playwright/test";

test("home page renders the logo", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("tom.Quest")).toBeVisible();
});

test("public quest pages load", async ({ page }) => {
  for (const route of ["/bio", "/help", "/game", "/thmm", "/clouds"]) {
    await page.goto(route);
    await expect(page.locator("body")).toBeVisible();
  }
});

test("unknown quests show the not found page", async ({ page }) => {
  await page.goto("/definitely-not-a-real-quest");
  await expect(page.getByText("That's not a place.")).toBeVisible();
});
