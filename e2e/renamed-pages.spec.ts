import { expect, test } from "@playwright/test";

// The pages renamed on 2026-09-26 (next.config.ts redirects): every link to
// /tts already sent to Slack lands on /jarvis with its query, and /observe
// lands on the /agents window view. Both targets are Tom's, so a guest sees
// their gate; the address is the claim.

test("an old /tts link lands on /jarvis with its query", async ({ page }) => {
  await page.goto("/tts?item=abc&intent=done");
  await expect(page).toHaveURL(/\/jarvis\?item=abc&intent=done$/);
});

test("/observe lands on the /agents window view", async ({ page }) => {
  await page.goto("/observe");
  await expect(page).toHaveURL(/\/agents\?view=window$/);
});
