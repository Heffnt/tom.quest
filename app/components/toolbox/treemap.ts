// The squarified treemap (Bruls, Huizing and van Wijk, 2000): rectangles whose
// areas are proportional to their counts, laid in rows along the shorter side
// so each rectangle stays as close to square as the counts allow. Pure, so the
// area figure's geometry is tested without a browser.

export type Box = { x: number; y: number; w: number; h: number };

/** The worst aspect ratio in a row of areas laid along a side of `side`. */
function worst(areas: number[], side: number): number {
  const sum = areas.reduce((a, b) => a + b, 0);
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/** Lays one row against the shorter side of `box` and returns what is left. */
function layRow<T>(row: { item: T; area: number }[], box: Box, out: (T & Box)[]): Box {
  const sum = row.reduce((a, r) => a + r.area, 0);
  if (box.w >= box.h) {
    const w = sum / box.h;
    let y = box.y;
    for (const r of row) {
      const h = r.area / w;
      out.push({ ...r.item, x: box.x, y, w, h });
      y += h;
    }
    return { x: box.x + w, y: box.y, w: box.w - w, h: box.h };
  }
  const h = sum / box.w;
  let x = box.x;
  for (const r of row) {
    const w = r.area / h;
    out.push({ ...r.item, x, y: box.y, w, h });
    x += w;
  }
  return { x: box.x, y: box.y + h, w: box.w, h: box.h - h };
}

/** Each item with a count above zero, placed in `box`, largest first. */
export function squarify<T extends { count: number }>(items: readonly T[], box: Box): (T & Box)[] {
  const sorted = items.filter((i) => i.count > 0).sort((a, b) => b.count - a.count);
  const total = sorted.reduce((a, i) => a + i.count, 0);
  if (total === 0 || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const out: (T & Box)[] = [];
  let rest = box;
  let row: { item: T; area: number }[] = [];
  for (const item of sorted) {
    const next = { item, area: item.count * scale };
    const side = Math.min(rest.w, rest.h);
    const areas = row.map((r) => r.area);
    if (row.length === 0 || worst([...areas, next.area], side) <= worst(areas, side)) {
      row.push(next);
    } else {
      rest = layRow(row, rest, out);
      row = [next];
    }
  }
  if (row.length > 0) layRow(row, rest, out);
  return out;
}
