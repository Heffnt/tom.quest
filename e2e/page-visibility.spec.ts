import { expect, test, type Page as PlaywrightPage } from "@playwright/test";
import { canSeePage, PAGES, type PageRole } from "../app/components/page-routes";
import { credentialsFor, signIn, type AuthRole } from "./helpers/auth";

function pageLink(page: PlaywrightPage, slug: string) {
  return page.locator(`a[href="/${slug}"]`);
}

async function expectPageListForRole(page: PlaywrightPage, role: PageRole) {
  await page.goto("/");
  for (const entry of PAGES) {
    const visible = canSeePage(role, entry);
    await expect(pageLink(page, entry.slug)).toHaveCount(visible ? 1 : 0);
  }
}

test("guest page list follows the page registry visibility filter", async ({ page }) => {
  await expectPageListForRole(page, "guest");
});

for (const role of ["user", "admin", "tom"] as AuthRole[]) {
  test(`${role} page list follows the page registry visibility filter`, async ({ page }) => {
    const credentials = credentialsFor(role);
    test.skip(!credentials, `Set E2E_${role.toUpperCase()}_USERNAME and E2E_${role.toUpperCase()}_PASSWORD to run this role coverage.`);
    if (!credentials) return;
    await signIn(page, credentials);
    await expectPageListForRole(page, role);
  });
}

test("guest direct navigation documents current gated-route behavior", async ({ page }) => {
  await page.goto("/turing");
  await expect(page.getByText("Sign in with an admin account")).toBeVisible();

  await page.goto("/jarvis");
  await expect(page.getByText("Jarvis access is restricted to Tom.")).toBeVisible();

  await page.goto("/logo");
  await expect(page.getByRole("heading", { name: "tom.Quest mark system" })).toBeVisible();
});
