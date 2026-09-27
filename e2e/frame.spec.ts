import { expect, test, type Page } from "@playwright/test";

// The frame on /frame, as a browser lays it out and a pointer uses it. The
// site header spans the top and is never covered. Under it, drawers never
// overlap one another: the side drawers run the full height, and the top and
// bottom drawers run exactly between them, shrinking as a side drawer opens
// or is dragged. A handle is its drawer's inner edge: pressed anywhere it
// opens the drawer, pressed again it shuts it, dragged it resizes it. None of
// it moves the center. A guest sees the frame with the restricted card in
// the center and empty drawers, which is all this needs.

type Edge = "top" | "left" | "right" | "bottom";
const EDGES: Edge[] = ["top", "left", "right", "bottom"];
const KEY: Record<Edge, string> = { top: "w", left: "a", bottom: "s", right: "d" };
type Box = { x: number; y: number; width: number; height: number };

const HEADER = 40;
const HANDLE = 28;

const openDrawers = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-frame-drawer][data-open=true]")].map((e) => e.getAttribute("data-frame-drawer")).sort(),
  );

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const handleBox = (page: Page, edge: Edge) => page.locator(`[data-frame-handle="${edge}"]`).boundingBox() as Promise<Box>;

/** Each drawer's box as it shows: its element's box cut to the stage, the part of the screen under the header. */
const shownBoxes = (page: Page) =>
  page.evaluate(() => {
    const stage = document.querySelector("[data-frame-stage]")!.getBoundingClientRect();
    const out: Record<string, { x: number; y: number; right: number; bottom: number }> = {};
    for (const el of document.querySelectorAll<HTMLElement>("[data-frame-drawer]")) {
      const r = el.getBoundingClientRect();
      out[el.dataset.frameDrawer!] = {
        x: Math.max(r.left, stage.left),
        y: Math.max(r.top, stage.top),
        right: Math.min(r.right, stage.right),
        bottom: Math.min(r.bottom, stage.bottom),
      };
    }
    return out;
  });

/** No two drawers share any area; the top and bottom run exactly between the side drawers; the header is where it always is. */
async function expectLaidOut(page: Page, viewport: { width: number; height: number }, when: string) {
  const b = await shownBoxes(page);
  const edges = Object.keys(b);
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const p = b[edges[i]];
      const q = b[edges[j]];
      const w = Math.min(p.right, q.right) - Math.max(p.x, q.x);
      const h = Math.min(p.bottom, q.bottom) - Math.max(p.y, q.y);
      expect(w > 0.5 && h > 0.5, `${when}: ${edges[i]} and ${edges[j]} overlap by ${w.toFixed(1)} x ${h.toFixed(1)}`).toBe(false);
    }
  }
  for (const end of ["top", "bottom"]) {
    expect(Math.abs(b[end].x - b.left.right), `${when}: ${end} starts where the left drawer ends`).toBeLessThan(0.5);
    expect(Math.abs(b[end].right - b.right.x), `${when}: ${end} ends where the right drawer begins`).toBeLessThan(0.5);
  }
  expect(Math.abs(b.top.y - HEADER), `${when}: the top drawer sits right under the header`).toBeLessThan(0.5);
  expect(await page.locator("[data-frame-header]").boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: HEADER });
  expect(await noSideScroll(page), `${when}: no sideways scroll`).toBe(true);
}

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

/** Wait until no drawer is moving: two reads of every box a frame apart agree. */
async function settled(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const read = () =>
          [...document.querySelectorAll("[data-frame-drawer]")].map((e) => JSON.stringify(e.getBoundingClientRect())).join();
        const a = read();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(read() === a)));
      }),
  );
}

async function ready(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto("/frame");
  await page.waitForFunction(() => document.querySelector("[data-frame]")?.getAttribute("data-hydrated") === "true");
  await settled(page);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`at ${viewport.width}px: drawers never overlap, the top and bottom run between the sides, and the center never moves`, async ({ page }) => {
    await ready(page, viewport);
    const center = page.locator("[data-frame-center]");
    const closed = await center.boundingBox();
    expect(closed).toEqual({
      x: HANDLE,
      y: HEADER + HANDLE,
      width: viewport.width - 2 * HANDLE,
      height: viewport.height - HEADER - 2 * HANDLE,
    });
    await expectLaidOut(page, viewport, "all shut");

    // Shut, each handle lies against its edge of the stage.
    const hb = Object.fromEntries(await Promise.all(EDGES.map(async (e) => [e, await handleBox(page, e)]))) as Record<Edge, Box>;
    const stageHeight = viewport.height - HEADER;
    expect(hb.left).toEqual({ x: 0, y: HEADER, width: HANDLE, height: stageHeight });
    expect(hb.right).toEqual({ x: viewport.width - HANDLE, y: HEADER, width: HANDLE, height: stageHeight });
    expect(hb.top).toEqual({ x: HANDLE, y: HEADER, width: viewport.width - 2 * HANDLE, height: HANDLE });
    expect(hb.bottom).toEqual({ x: HANDLE, y: viewport.height - HANDLE, width: viewport.width - 2 * HANDLE, height: HANDLE });

    // Every combination of open drawers, reached from the keyboard.
    for (let mask = 0; mask < 16; mask++) {
      const want = EDGES.filter((_, i) => mask & (1 << i));
      for (const edge of EDGES) {
        const isOpen = (await openDrawers(page)).includes(edge);
        if (isOpen !== want.includes(edge)) {
          await page.keyboard.press(KEY[edge]);
          await settled(page);
        }
      }
      const open = await openDrawers(page);
      await expectLaidOut(page, viewport, `open: ${open.join(", ") || "none"}`);
      expect(await center.boundingBox(), `center with ${open.join(", ")} open`).toEqual(closed);
    }
    for (const edge of await openDrawers(page)) await page.keyboard.press(KEY[edge as Edge]);
    await settled(page);
    expect(await openDrawers(page)).toEqual([]);
  });

  test(`at ${viewport.width}px: a handle opens on a press anywhere, shuts on the next, and a drag resizes it with the pointer`, async ({ page }) => {
    await ready(page, viewport);
    const center = page.locator("[data-frame-center]");
    const closed = await center.boundingBox();

    for (const edge of EDGES) {
      const points = await pressablePoints(page, edge, [0.15, 0.5, 0.85]);
      expect(points.length, `${edge}: pressable points`).toBeGreaterThan(0);
      for (const point of points) {
        await page.mouse.click(point.x, point.y);
        await settled(page);
        expect(await openDrawers(page), `${edge} opened from ${Math.round(point.x)},${Math.round(point.y)}`).toEqual([edge]);
        expect(await center.boundingBox()).toEqual(closed);
        const [open] = await pressablePoints(page, edge, [0.5, 0.3, 0.7]);
        await page.mouse.click(open.x, open.y);
        await settled(page);
        expect(await openDrawers(page), `${edge} shut`).toEqual([]);
      }

      // A drag from the shut handle pulls the drawer out, and the handle
      // follows the pointer move by move.
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
        await expectLaidOut(page, viewport, `${edge} mid-drag at ${step}`);
      }
      await page.mouse.up();
      await settled(page);
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
      await settled(page);
      expect(await openDrawers(page), `${edge} dragged shut`).toEqual([]);
      expect(await center.boundingBox()).toEqual(closed);
    }
  });

  test(`at ${viewport.width}px: dragging a side drawer resizes the top and bottom live, and into the other side it stops`, async ({ page }) => {
    await ready(page, viewport);
    const center = page.locator("[data-frame-center]");
    const closed = await center.boundingBox();
    for (const key of ["w", "s", "a", "d"]) {
      await page.keyboard.press(key);
      await settled(page);
    }
    const sides = (await openDrawers(page)).filter((e) => e === "left" || e === "right") as Edge[];
    // On a phone the two sides cannot both be open: the one opened last is.
    expect(sides).toEqual(viewport.width < 500 ? ["right"] : ["left", "right"]);
    for (const edge of sides) {
      const [from] = await pressablePoints(page, edge, [0.5, 0.4, 0.6]);
      const dir = edge === "left" ? 1 : -1;
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (const step of [-120, -60, 40, 200, 600, 1200, viewport.width]) {
        await page.mouse.move(Math.min(viewport.width - 1, Math.max(1, from.x + dir * step)), from.y);
        await expectLaidOut(page, viewport, `${edge} dragged ${step}`);
        expect(await center.boundingBox()).toEqual(closed);
      }
      await page.mouse.up();
      await settled(page);
      await expectLaidOut(page, viewport, `${edge} let go past the far side`);
      // Pulled as far as it goes, the other side is at its minimum (or, on a phone, absent) and every handle still shows.
      for (const e of await openDrawers(page)) {
        const box = await handleBox(page, e as Edge);
        expect(box.width, `${e} handle keeps its width`).toBeGreaterThan(0);
        expect(box.height, `${e} handle keeps its height`).toBeGreaterThan(0);
      }
    }
  });
}

test("the header's controls keep their presses, and the (i) opens the frame explainer full screen and dark", async ({ page }) => {
  await ready(page, { width: 1440, height: 900 });
  await page.keyboard.press("a");
  await settled(page);
  await page.getByRole("button", { name: /^Explainer:/ }).click();
  const viewer = page.locator("[data-explainer=frame]");
  await expect(viewer).toBeVisible();
  const frame = page.frameLocator("[data-explainer=frame] iframe");
  await expect(frame.locator("h1")).toHaveText("The frame");
  expect(await frame.locator("body").evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgb(23, 24, 26)");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  expect(await openDrawers(page)).toEqual(["left"]);
  // The header lies over everything: its middle belongs to it wherever the drawers are.
  const owner = await page.evaluate(() => document.elementFromPoint(720, 20)?.closest("[data-frame-header]") !== null);
  expect(owner).toBe(true);
  await page.getByRole("button", { name: "Log in" }).click();
  expect(await openDrawers(page)).toEqual(["left"]);
});
