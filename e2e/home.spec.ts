import { expect, test } from "@playwright/test";
import { expectNoMovement, expectNoRecordedMovement, installMovementObserver } from "./helpers/no-movement";

test("home page does not focus or scroll on passive load", async ({ page }) => {
  await installMovementObserver(page);
  await page.goto("/");

  await expect(page.getByLabel("tom.Quest")).toBeVisible();
  await expect(page.getByPlaceholder("pick a destination")).not.toBeFocused();
  await expectNoRecordedMovement(page);
});

test("home page keeps passive inspection still", async ({ page }) => {
  await installMovementObserver(page);
  await page.goto("/");

  await expectNoMovement(page, async () => {
    await expect(page.getByRole("link", { name: /\/bio/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  });
});

test("home destination input focuses only after user interaction", async ({ page }) => {
  await page.goto("/");

  const input = page.getByPlaceholder("pick a destination");
  await expect(input).not.toBeFocused();
  await input.click();
  await expect(input).toBeFocused();
});
