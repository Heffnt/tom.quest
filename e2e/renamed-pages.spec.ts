import { expect, test } from "@playwright/test";

// The pages renamed or removed (next.config.ts redirects): every link to /tts
// already sent to Slack lands on /jarvis with its query, and a link to the
// removed /agents, /runs, /observe and /thread pages lands on /sessions. The
// targets are Tom's, so a guest sees their gate; the address is the claim.

test("an old /tts link lands on /jarvis with its query", async ({ page }) => {
  await page.goto("/tts?item=abc&intent=done");
  await expect(page).toHaveURL(/\/jarvis\?item=abc&intent=done$/);
});

test("an old /agents link lands on /sessions with its query", async ({ page }) => {
  await page.goto("/agents?session=abc");
  await expect(page).toHaveURL(/\/sessions\?session=abc$/);
});

test("an old /runs?run= link opens that agent on /sessions", async ({ page }) => {
  await page.goto("/runs?run=claude%3Abox%3Aabcdefgh");
  // The original query passes through beside the one the rule writes, so
  // ?run= stays on the address and the page reads ?agent=.
  await expect(page).toHaveURL(/\/sessions\?(.*&)?agent=claude(%3A|:)box(%3A|:)abcdefgh/);
});

test("/observe and /thread land on /sessions", async ({ page }) => {
  await page.goto("/observe");
  await expect(page).toHaveURL(/\/sessions$/);
  await page.goto("/thread");
  await expect(page).toHaveURL(/\/sessions$/);
});

// /sessions redirected to /agents from 2026-09-21 until the sessions page took
// the path back on 2026-10-06.
test("/sessions is the sessions page, not a redirect to /agents", async ({ page }) => {
  await page.goto("/sessions?session=abc");
  await expect(page).toHaveURL(/\/sessions\?session=abc$/);
});
