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

// Round 1 of the mockups: four looks for a closed drawer (frame/variants.tsx).
// Whichever is chosen, the center keeps its box with every drawer closed and
// open, nothing scrolls sideways, every handle is on top where it sits, and no
// title in a rail is cut short.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`every closed-drawer variant keeps the center still at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/tts");
    await page.waitForFunction(() => document.querySelector("[data-frame]")?.getAttribute("data-hydrated") === "true");
    const center = page.locator("[data-frame-center]");
    for (const [i, variant] of ["A", "B", "C", "D"].entries()) {
      await page.keyboard.press(String(i + 1));
      await expect(page.locator("[data-frame]")).toHaveAttribute("data-frame-variant", variant);
      await page.waitForTimeout(200);
      const closed = await center.boundingBox();
      expect(await noSideScroll(page)).toBe(true);

      const handles = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("[data-frame-toggle]")]
          .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === "absolute")
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            const label = el.querySelector<HTMLElement>("[data-frame-rail-label]");
            return {
              edge: el.getAttribute("data-frame-toggle"),
              onTop: !!hit && el.contains(hit),
              inside: r.left >= 0 && r.right <= window.innerWidth + 0.5,
              titleWhole: !label || el.hasAttribute("data-frame-rail") || label.scrollWidth <= label.clientWidth + 1,
            };
          }),
      );
      for (const h of handles) expect(h, `${variant} ${h.edge}`).toEqual({ edge: h.edge, onTop: true, inside: true, titleWhole: true });

      for (const key of ["s", "d", "a", "w"]) {
        await page.keyboard.press(key);
        await page.waitForTimeout(200);
        expect(await center.boundingBox(), `${variant} after ${key}`).toEqual(closed);
        expect(await noSideScroll(page)).toBe(true);
      }
      for (let n = 0; n < 4; n++) await page.keyboard.press("Escape");
      expect(await openDrawers(page)).toEqual([]);
    }
    await page.keyboard.press("1");
  });
}

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
