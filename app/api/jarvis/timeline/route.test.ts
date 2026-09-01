import { beforeEach, describe, expect, it, vi } from "vitest";

const requireTom = vi.fn();

vi.mock("@/app/lib/convex-server", () => ({
  requireTom,
}));

// The window is centered on `center`, so every request below passes one
// explicitly: without it the route falls back to the current day and the
// expected dates would move with the clock.
const CENTER = "2026-01-15";

async function get(query: string) {
  const { GET } = await import("@/app/api/jarvis/timeline/route");
  return GET(new Request(`http://localhost/api/jarvis/timeline${query}`) as never);
}

async function datesOf(response: Response) {
  const payload = (await response.json()) as { center: string; days: Array<{ date: string }> };
  return payload.days.map((day) => day.date);
}

describe("GET /api/jarvis/timeline", () => {
  beforeEach(() => {
    requireTom.mockReset();
    requireTom.mockResolvedValue({ _id: "tom-id", role: "tom", isTom: true });
  });

  it("rejects a non-numeric days parameter instead of returning an empty window", async () => {
    // Regression: Number("x") is NaN, and both Math.min and Math.max forward
    // NaN untouched, so this used to return HTTP 200 with days: [].
    const response = await get(`?center=${CENTER}&days=x`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid days parameter" });
  });

  it.each(["NaN", "null", "undefined", "Infinity", "-Infinity"])(
    "rejects days=%s",
    async (value) => {
      const response = await get(`?center=${CENTER}&days=${value}`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid days parameter" });
    },
  );

  it("returns exactly the number of days asked for when that number is even", async () => {
    // Regression: the loop ran -half..+half inclusive, so days=4 returned 5.
    const response = await get(`?center=${CENTER}&days=4`);

    expect(response.status).toBe(200);
    await expect(datesOf(response)).resolves.toEqual([
      "2026-01-14",
      "2026-01-15",
      "2026-01-16",
      "2026-01-17",
    ]);
  });

  it("returns the same five days it returned before the fix when days=5", async () => {
    const response = await get(`?center=${CENTER}&days=5`);

    expect(response.status).toBe(200);
    await expect(datesOf(response)).resolves.toEqual([
      "2026-01-13",
      "2026-01-14",
      "2026-01-15",
      "2026-01-16",
      "2026-01-17",
    ]);
  });

  it("falls back to a five-day window when days is absent", async () => {
    const response = await get(`?center=${CENTER}`);

    expect(response.status).toBe(200);
    await expect(datesOf(response)).resolves.toEqual([
      "2026-01-13",
      "2026-01-14",
      "2026-01-15",
      "2026-01-16",
      "2026-01-17",
    ]);
  });

  it("falls back to a five-day window when days is present but empty", async () => {
    // `|| "5"` catches the empty string as well as an absent parameter.
    const response = await get(`?center=${CENTER}&days=`);

    expect(response.status).toBe(200);
    await expect(datesOf(response)).resolves.toHaveLength(5);
  });

  it("clamps a numeric value above the ceiling to nine days", async () => {
    const response = await get(`?center=${CENTER}&days=100`);

    expect(response.status).toBe(200);
    await expect(datesOf(response)).resolves.toHaveLength(9);
  });

  it("clamps a numeric value below the floor to one day", async () => {
    const response = await get(`?center=${CENTER}&days=-3`);

    expect(response.status).toBe(200);
    await expect(datesOf(response)).resolves.toEqual([CENTER]);
  });

  it("truncates a fractional value rather than carrying it into the loop", async () => {
    const response = await get(`?center=${CENTER}&days=3.7`);

    expect(response.status).toBe(200);
    await expect(datesOf(response)).resolves.toEqual([
      "2026-01-14",
      "2026-01-15",
      "2026-01-16",
    ]);
  });

  it("keeps the center day inside the window for every accepted count", async () => {
    for (let requested = 1; requested <= 9; requested += 1) {
      const response = await get(`?center=${CENTER}&days=${requested}`);
      const dates = await datesOf(response);

      expect(dates).toHaveLength(requested);
      expect(dates).toContain(CENTER);
    }
  });

  it("echoes the center day back to the caller", async () => {
    const response = await get(`?center=${CENTER}&days=1`);
    const payload = (await response.json()) as { center: string };

    expect(payload.center).toBe(CENTER);
  });
});
