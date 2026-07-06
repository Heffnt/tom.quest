// Shared bits for the perfume bench specs (e2e/perfume.spec.ts).
// Single-user specs run on /perfume?local=1 (LocalBenchStore — no Convex
// traffic) with ?seed=basic, the deterministic inventory defined in
// app/perfume/lib/bench-store.ts: 3× Noble Roses (emits A,A), 2× Aphasia
// Flower (Crallax,En), 1× Pemneath Peat (N,N), 1× Shadow Demon Liver (⊖⊖),
// 2× Pure Strike.

import { expect, type Locator, type Page } from "@playwright/test";

export const ROSES = "base:Noble Roses";
export const APHASIA = "base:Aphasia Flower";
export const PEAT = "base:Pemneath Peat";
export const SERUM = "base:swanas-serum"; // recipe [A, A, Crallax, En]
export const BLACK_GAS = "base:black-gas"; // recipe [N] — k-multiples

export async function openLocalBench(page: Page): Promise<void> {
  await page.goto("/perfume?local=1&seed=basic");
  await expect(invSlot(page, ROSES)).toBeVisible();
}

export function invSlot(page: Page, itemKey: string): Locator {
  return page.locator(
    `[data-testid="inventory-slot"][data-item-key="${itemKey}"]`,
  );
}

export function catalogRow(page: Page, itemKey: string): Locator {
  return page.locator(`[data-testid="catalog-row"][data-item-key="${itemKey}"]`);
}

export function arcNode(page: Page, itemKey: string): Locator {
  return page.locator(
    `[data-testid="arc-ingredient"][data-item-key="${itemKey}"]`,
  );
}

export function freqFloats(page: Page, freq?: string): Locator {
  return page.locator(
    freq
      ? `[data-testid="freq-float"][data-freq="${freq}"]`
      : '[data-testid="freq-float"]',
  );
}

export function handGhost(page: Page): Locator {
  return page.getByTestId("hand-ghost");
}

export function stage(page: Page): Locator {
  return page.locator('[data-pf-surface="stage"]');
}

async function center(target: Locator): Promise<{ x: number; y: number }> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("drag target has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Press the mouse on `from` and travel to `to` WITHOUT releasing — the
 * caller asserts mid-drag state, then releases (or keeps moving). Stepped
 * moves so every boundary crossing sees pointermove events. */
export async function pressAndDrag(
  page: Page,
  from: Locator,
  to: Locator,
): Promise<void> {
  const a = await center(from);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  // clear the hand's 5px press threshold while still over the origin panel
  await page.mouse.move(a.x + 12, a.y, { steps: 3 });
  await dragOver(page, to);
}

/** Continue an in-progress drag (button held) over another target. */
export async function dragOver(page: Page, to: Locator): Promise<void> {
  const b = await center(to);
  await page.mouse.move(b.x, b.y, { steps: 12 });
}
