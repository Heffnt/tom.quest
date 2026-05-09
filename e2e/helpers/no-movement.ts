import { expect, type Page } from "@playwright/test";

type MovementSnapshot = {
  scrollX: number;
  scrollY: number;
  scrollEvents: number;
  focusEvents: number;
  activeTag: string;
};

declare global {
  interface Window {
    __tomQuestMovement?: {
      scrollEvents: number;
      focusEvents: number;
    };
  }
}

async function snapshot(page: Page): Promise<MovementSnapshot> {
  return await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrollEvents: window.__tomQuestMovement?.scrollEvents ?? 0,
    focusEvents: window.__tomQuestMovement?.focusEvents ?? 0,
    activeTag: document.activeElement?.tagName ?? "",
  }));
}

export async function installMovementObserver(page: Page) {
  await page.addInitScript(() => {
    window.__tomQuestMovement = { scrollEvents: 0, focusEvents: 0 };
    window.addEventListener(
      "scroll",
      () => {
        if (window.__tomQuestMovement) window.__tomQuestMovement.scrollEvents += 1;
      },
      true,
    );
    window.addEventListener(
      "focusin",
      () => {
        if (window.__tomQuestMovement) window.__tomQuestMovement.focusEvents += 1;
      },
      true,
    );
  });
}

export async function resetMovementObserver(page: Page) {
  await page.evaluate(() => {
    window.__tomQuestMovement = { scrollEvents: 0, focusEvents: 0 };
  });
}

export async function expectNoMovement(page: Page, action: () => Promise<void>) {
  await resetMovementObserver(page);
  const before = await snapshot(page);
  await action();
  await page.waitForTimeout(100);
  const after = await snapshot(page);

  expect(after.scrollX).toBe(before.scrollX);
  expect(after.scrollY).toBe(before.scrollY);
  expect(after.scrollEvents).toBe(0);
  expect(after.focusEvents).toBe(0);
  expect(after.activeTag).toBe(before.activeTag);
}

export async function expectNoRecordedMovement(page: Page) {
  await page.waitForTimeout(100);
  const current = await snapshot(page);
  expect(current.scrollX).toBe(0);
  expect(current.scrollY).toBe(0);
  expect(current.scrollEvents).toBe(0);
  expect(current.focusEvents).toBe(0);
}
