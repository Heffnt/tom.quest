import { expect, test, type Page } from "@playwright/test";

// The frame's geometry and handles, as a browser lays them out and a pointer
// uses them. A drawer's handle is its outer edge: pressed anywhere it opens
// the drawer, pressed again it shuts it, dragged it pulls the drawer to any
// size and the handle follows the pointer. None of it moves the center.
// Corners go top, sides, bottom. A guest sees the frame with the restricted
// card in the center, which is all this needs.

type Edge = "top" | "left" | "right" | "bottom";
const EDGES: Edge[] = ["top", "left", "right", "bottom"];
type Box = { x: number; y: number; width: number; height: number };

const openDrawers = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-frame-drawer][data-open=true]")].map((e) => e.getAttribute("data-frame-drawer")).sort(),
  );

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const handleBox = (page: Page, edge: Edge) => page.locator(`[data-frame-handle="${edge}"]`).boundingBox() as Promise<Box>;

/** Points along a handle's length, at the fractions given, that land on the handle itself and not on a control on it. */
async function pressablePoints(page: Page, edge: Edge, fractions: number[]) {
  return page.evaluate(
    ({ edge, fractions }) => {
      const el = document.querySelector<HTMLElement>(`[data-frame-handle="${edge}"]`)!;
      const r = el.getBoundingClientRect();
      const along = edge === "top" || edge === "bottom";
      return fractions
        .map((f) => (along ? { x: r.left + r.width * f, y: r.top + r.height / 2 } : { x: r.left + r.width / 2, y: r.top + r.height * f }))
        .filter(({ x, y }) => {
          const hit = document.elementFromPoint(x, y);
          return !!hit && el.contains(hit) && !hit.closest("[data-frame-handle-control]");
        });
    },
    { edge, fractions },
  );
}

async function ready(page: Page, viewport: { width: number; height: number }, variantKey: string) {
  await page.setViewportSize(viewport);
  await page.goto("/tts");
  await page.waitForFunction(() => document.querySelector("[data-frame]")?.getAttribute("data-hydrated") === "true");
  await page.keyboard.press(variantKey);
  await page.waitForTimeout(200);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const [variantKey, variant, thickness] of [
    ["1", "A", 28],
    ["2", "B", 44],
  ] as const) {
    test(`variant ${variant} at ${viewport.width}px: handles open, drag and shut their drawers, and the center never moves`, async ({ page }) => {
      await ready(page, viewport, variantKey);
      await expect(page.locator("[data-frame]")).toHaveAttribute("data-frame-variant", variant);
      const center = page.locator("[data-frame-center]");
      const closed = await center.boundingBox();
      expect(closed).toEqual({
        x: thickness,
        y: thickness,
        width: viewport.width - 2 * thickness,
        height: viewport.height - 2 * thickness,
      });
      expect(await noSideScroll(page)).toBe(true);

      // Corner priority when shut: the top spans the full width; the sides
      // run from below it to the bottom of the screen; the bottom sits between.
      const hb = Object.fromEntries(await Promise.all(EDGES.map(async (e) => [e, await handleBox(page, e)]))) as Record<Edge, Box>;
      expect(hb.top).toEqual({ x: 0, y: 0, width: viewport.width, height: thickness });
      expect(hb.left).toEqual({ x: 0, y: thickness, width: thickness, height: viewport.height - thickness });
      expect(hb.right).toEqual({ x: viewport.width - thickness, y: thickness, width: thickness, height: viewport.height - thickness });
      expect(hb.bottom).toEqual({ x: thickness, y: viewport.height - thickness, width: viewport.width - 2 * thickness, height: thickness });

      for (const edge of EDGES) {
        // A press anywhere along the shut handle opens it; a press on the open handle shuts it.
        const points = await pressablePoints(page, edge, [0.15, 0.5, 0.85]);
        expect(points.length, `${edge}: pressable points`).toBeGreaterThan(0);
        for (const point of points) {
          await page.mouse.click(point.x, point.y);
          await page.waitForTimeout(220);
          expect(await openDrawers(page), `${edge} opened from ${Math.round(point.x)},${Math.round(point.y)}`).toEqual([edge]);
          expect(await center.boundingBox()).toEqual(closed);
          const [open] = await pressablePoints(page, edge, [0.5, 0.3, 0.7]);
          await page.mouse.click(open.x, open.y);
          await page.waitForTimeout(220);
          expect(await openDrawers(page), `${edge} shut`).toEqual([]);
        }

        // A drag from the shut handle pulls the drawer out, and the handle
        // follows the pointer frame by frame.
        const [from] = await pressablePoints(page, edge, [0.5, 0.3, 0.7]);
        const dir = { top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0] }[edge];
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        const before = await handleBox(page, edge);
        for (const step of [20, 60, 120, 180]) {
          await page.mouse.move(from.x + dir[0] * step, from.y + dir[1] * step);
          const now = await handleBox(page, edge);
          expect(now.x - before.x, `${edge} follows x at ${step}`).toBeCloseTo(dir[0] * step, 0);
          expect(now.y - before.y, `${edge} follows y at ${step}`).toBeCloseTo(dir[1] * step, 0);
          expect(await center.boundingBox(), `${edge} mid-drag`).toEqual(closed);
          expect(await noSideScroll(page)).toBe(true);
        }
        await page.mouse.up();
        await page.waitForTimeout(220);
        expect(await openDrawers(page)).toEqual([edge]);
        const after = await handleBox(page, edge);
        expect(after.x - before.x).toBeCloseTo(dir[0] * 180, 0);
        expect(after.y - before.y).toBeCloseTo(dir[1] * 180, 0);

        // Dragged back to the edge, it shuts.
        const [back] = await pressablePoints(page, edge, [0.5, 0.3, 0.7]);
        await page.mouse.move(back.x, back.y);
        await page.mouse.down();
        await page.mouse.move(back.x - dir[0] * 170, back.y - dir[1] * 170, { steps: 4 });
        await page.mouse.up();
        await page.waitForTimeout(220);
        expect(await openDrawers(page), `${edge} dragged shut`).toEqual([]);
        expect(await center.boundingBox()).toEqual(closed);
      }

      // The buttons on the top handle keep their presses: the other variant's
      // button in the picker switches the look and leaves the drawer shut.
      const other = variant === "A" ? "B" : "A";
      await page.getByRole("radio", { name: other }).click();
      await expect(page.locator("[data-frame]")).toHaveAttribute("data-frame-variant", other);
      expect(await openDrawers(page)).toEqual([]);
      await page.getByRole("radio", { name: variant }).click();
      expect(await openDrawers(page)).toEqual([]);

      // All four open: the center is where it was, the top lies over the
      // sides, the sides over the bottom's ends, and nothing scrolls sideways.
      for (const key of ["s", "a", "d", "w"]) {
        await page.keyboard.press(key);
        await page.waitForTimeout(220);
        expect(await center.boundingBox()).toEqual(closed);
        expect(await noSideScroll(page)).toBe(true);
      }
      expect(await openDrawers(page)).toEqual(["bottom", "left", "right", "top"]);
      const owner = await page.evaluate(() => {
        const at = (x: number, y: number) =>
          document.elementFromPoint(x, y)?.closest("[data-frame-drawer]")?.getAttribute("data-frame-drawer") ?? null;
        const top = document.querySelector('[data-frame-handle="top"]')!.getBoundingClientRect();
        const bottom = document.querySelector('[data-frame-handle="bottom"]')!.getBoundingClientRect();
        const W = window.innerWidth;
        return {
          topLeft: at(2, top.top + 2),
          topRight: at(W - 2, top.top + 2),
          bottomLeftEnd: at(bottom.left + 2, bottom.top + bottom.height / 2),
          bottomRightEnd: at(bottom.right - 2, bottom.top + bottom.height / 2),
        };
      });
      expect(owner.topLeft).toBe("top");
      expect(owner.topRight).toBe("top");
      expect([owner.bottomLeftEnd, owner.bottomRightEnd]).toEqual(["left", "right"]);

      // Escape shuts the topmost first: the top, then the side opened last, then the other, then the bottom.
      for (const expected of [
        ["bottom", "left", "right"],
        ["bottom", "left"],
        ["bottom"],
        [],
      ]) {
        await page.keyboard.press("Escape");
        expect(await openDrawers(page)).toEqual(expected);
      }
      await page.keyboard.press("1");
    });
  }
}

test("the (i) on the top handle opens the frame explainer full screen, dark, leaves the drawer shut, and Escape closes it", async ({ page }) => {
  await page.goto("/tts");
  await page.waitForFunction(() => document.querySelector("[data-frame]")?.getAttribute("data-hydrated") === "true");
  await page.getByRole("button", { name: /^Explainer:/ }).click();
  const viewer = page.locator("[data-explainer=frame]");
  await expect(viewer).toBeVisible();
  const frame = page.frameLocator("[data-explainer=frame] iframe");
  await expect(frame.locator("h1")).toHaveText("The frame");
  expect(await frame.locator("body").evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgb(23, 24, 26)");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  expect(await openDrawers(page)).toEqual([]);
});
