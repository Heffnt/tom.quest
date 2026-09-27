import { expect, test, type Page } from "@playwright/test";

// The frame's geometry, as a browser lays it out: opening drawers never moves
// the center, the right drawer lies over the bottom one where they meet,
// Escape closes the topmost first, and nothing scrolls sideways. A guest sees
// the frame with the restricted card in the center, which is all this needs.

const openDrawers = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-frame-drawer][data-open=true]")].map((e) => e.getAttribute("data-frame-drawer")),
  );

const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("drawers overlay the center and stack right over left over bottom over top", async ({ page }) => {
  await page.goto("/tts");
  await page.locator("[data-frame-center]").waitFor();
  await page.waitForFunction(() => document.querySelector("[data-frame]")?.getAttribute("data-hydrated") === "true");
  const center = page.locator("[data-frame-center]");
  const before = await center.boundingBox();
  const phone = (page.viewportSize()?.width ?? 0) < 640;

  for (const key of ["s", "d", "a", "w"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(200);
    expect(await center.boundingBox()).toEqual(before);
    expect(await noSideScroll(page)).toBe(true);
  }

  if (phone) {
    // Sheets come one at a time: the last key pressed is the only one open.
    expect(await openDrawers(page)).toEqual(["top"]);
    return;
  }

  // Desktop: all four open; at the bottom-right meeting point the right drawer wins.
  expect((await openDrawers(page)).sort()).toEqual(["bottom", "left", "right", "top"]);
  const winner = await page.evaluate(() => {
    const r = document.querySelector('[data-frame-drawer="right"]')!.getBoundingClientRect();
    const b = document.querySelector('[data-frame-drawer="bottom"]')!.getBoundingClientRect();
    return document.elementFromPoint(r.left + 10, b.top + 10)?.closest("[data-frame-drawer]")?.getAttribute("data-frame-drawer");
  });
  expect(winner).toBe("right");
  // Each rail is above every drawer: the element at a rail's midpoint is that rail.
  for (const edge of ["top", "bottom", "left", "right"]) {
    const hit = await page.evaluate((e) => {
      const r = document.querySelector(`[data-frame-rail="${e}"]`)!.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("[data-frame-rail]")?.getAttribute("data-frame-rail");
    }, edge);
    expect(hit).toBe(edge);
  }

  for (const expected of [["bottom", "left", "top"], ["bottom", "top"], ["top"], []]) {
    await page.keyboard.press("Escape");
    expect((await openDrawers(page)).sort()).toEqual(expected);
  }
});

test("the (i) after the page name opens the frame explainer full screen, dark, and Escape closes it", async ({ page }) => {
  await page.goto("/tts");
  await page.getByRole("button", { name: /^Explainer:/ }).click();
  const viewer = page.locator("[data-explainer=frame]");
  await expect(viewer).toBeVisible();
  const frame = page.frameLocator("[data-explainer=frame] iframe");
  await expect(frame.locator("h1")).toHaveText("The frame");
  expect(await frame.locator("body").evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgb(23, 24, 26)");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
});
