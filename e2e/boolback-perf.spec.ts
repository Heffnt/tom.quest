import { expect, test } from "@playwright/test";

// Verifies the settings-model refinements against the live dev snapshot:
//  1. a fresh Plot lands on the dominant cell (facets pre-pinned, subset of runs);
//  2. a parameter's option checkboxes are ordered by run count, descending;
//  3. a filter-checkbox click's interaction latency (Event Timing "event"
//     duration = handler + next paint, the INP component) stays well under the
//     200ms "good" threshold — the reported regression was ~304ms.

async function gotoPlot(page: import("@playwright/test").Page): Promise<number> {
  await page.goto("/boolback");
  const plot = page.getByRole("button", { name: "Plot", exact: true });
  await expect(plot).toBeVisible({ timeout: 30_000 });
  await plot.click();
  await expect(page.locator("svg[role=img]").first()).toBeVisible({ timeout: 30_000 });
  // Total rows in the snapshot; the tiny bundled fixture (< 1000, no Turing) is
  // too small to exercise the plot's real cost, so callers skip on it.
  const text = (await page.getByText(/of \d+ runs/).first().textContent()) ?? "";
  return Number((text.match(/of\s+([\d,]+)/)?.[1] ?? "0").replace(/,/g, ""));
}

test("fresh Plot lands on the dominant cell (facets pre-pinned)", async ({ page }) => {
  const total0 = await gotoPlot(page);
  test.skip(total0 < 1000, "needs the full Turing snapshot");
  // The counter reads "<union> of <total> runs"; dominant pinning ⇒ union < total.
  const counter = page.getByText(/of \d+ runs/).first();
  await expect(counter).toBeVisible();
  const text = (await counter.textContent()) ?? "";
  const m = text.match(/([\d,]+)\s+of\s+([\d,]+)/);
  expect(m, `counter text: ${text}`).not.toBeNull();
  const union = Number(m![1].replace(/,/g, ""));
  const total = Number(m![2].replace(/,/g, ""));
  expect(total).toBeGreaterThan(1000); // full snapshot, not the tiny fixture
  expect(union).toBeGreaterThan(0);
  expect(union).toBeLessThan(total); // dominant cell is a strict subset
  // At least one facet checkbox is pre-checked (a visible pin, not hidden).
  const checked = await page.locator('input[type=checkbox][aria-label^="filter "]:checked').count();
  expect(checked).toBeGreaterThan(0);
});

test("a parameter's options are ordered by run count, descending", async ({ page }) => {
  const total1 = await gotoPlot(page);
  test.skip(total1 < 1000, "needs the full Turing snapshot");
  // Read the count badges under one high-cardinality categorical chip (Dataset).
  // Each option row shows "<value> <count>"; collect the counts in DOM order.
  const counts = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('input[type=checkbox][aria-label^="filter Dataset "]')];
    const out: number[] = [];
    for (const el of boxes) {
      const cnt = el.parentElement?.querySelector("span.tabular-nums");
      if (cnt?.textContent) out.push(Number(cnt.textContent.replace(/,/g, "")));
    }
    return out;
  });
  expect(counts.length).toBeGreaterThan(2);
  for (let i = 1; i < counts.length; i++) {
    expect(counts[i], `counts not descending at ${i}: ${counts.join(",")}`).toBeLessThanOrEqual(counts[i - 1]);
  }
});

test("filter-checkbox click interaction latency stays under 200ms", async ({ page }) => {
  const total2 = await gotoPlot(page);
  test.skip(total2 < 1000, "needs the full Turing snapshot");
  await page.evaluate(() => {
    (window as unknown as { __evtMax: number }).__evtMax = 0;
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const d = (e as PerformanceEntry & { duration: number }).duration;
        const w = window as unknown as { __evtMax: number };
        if (d > w.__evtMax) w.__evtMax = d;
      }
    });
    po.observe({ type: "event", durationThreshold: 0, buffered: false } as PerformanceObserverInit);
  });
  // Toggle a rare-value facet so the union genuinely changes (worst case: the
  // plot must re-resolve + redraw). agnews is a non-dominant dataset value.
  const box = page.locator('input[type=checkbox][aria-label="filter Dataset agnews"]').first();
  await expect(box).toBeVisible();
  await box.click();
  await page.waitForTimeout(600); // let Event Timing flush past the next paint
  const maxDur = await page.evaluate(() => (window as unknown as { __evtMax: number }).__evtMax);
  console.log(`[INP] worst interaction event duration = ${maxDur}ms`);
  // Event Timing duration is rounded to 8ms; a 304ms block would read ~304.
  expect(maxDur, `worst interaction event duration = ${maxDur}ms`).toBeLessThan(200);
});
