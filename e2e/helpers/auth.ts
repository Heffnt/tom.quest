import { expect, type Page } from "@playwright/test";

export type AuthRole = "user" | "admin" | "tom";

export type Credentials = {
  username: string;
  password: string;
};

export function credentialsFor(role: AuthRole): Credentials | null {
  const prefix = `E2E_${role.toUpperCase()}`;
  const username = process.env[`${prefix}_USERNAME`];
  const password = process.env[`${prefix}_PASSWORD`];
  return username && password ? { username, password } : null;
}

export async function signIn(page: Page, credentials: Credentials) {
  await page.goto("/");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toHaveCount(0, { timeout: 15_000 });
}

export async function signOut(page: Page) {
  await page.getByRole("button").filter({ hasNotText: "Log in" }).first().click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible({ timeout: 15_000 });
}
