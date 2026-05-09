import { expect, test } from "@playwright/test";

test("sign up, sign out, and sign back in", async ({ page }) => {
  test.skip(process.env.E2E_AUTH_FLOW !== "1", "Set E2E_AUTH_FLOW=1 and run against a Convex-backed dev server.");

  const username = `e2e${Date.now()}`;
  const password = `pw-${Date.now()}`;

  await page.goto("/");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create Account" }).click();

  await expect(page.getByRole("button", { name: username })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: username }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page.getByRole("button", { name: username })).toBeVisible({ timeout: 20_000 });
});
