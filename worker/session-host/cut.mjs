// cut.mjs — the bounded rendering copy of a transcript payload.
//
// The whole payload still has a home in overflow.mjs. This file owns only the
// 32KB display bound so parsers can use the exact daemon cut without loading
// lib.mjs: that module reaches the box-only worker-env symlink, which is a
// plain text file in a Windows checkout and therefore cannot be loaded by
// vitest. Keeping one body prevents the rendered row and its overflow copy
// from silently disagreeing about which bytes were cut.

import { overflowFor } from "./overflow.mjs";

export const TRUNCATE_LIMIT = 32 * 1024;
export const ERROR_TEXT_LIMIT = 8 * 1024;

export function rowText(value) {
  if (typeof value === "string") return value;
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    json = String(value);
  }
  return json === undefined ? null : json;
}

export function cutRow(text, value, limit) {
  if (text === null) return { value: null };
  if (text.length <= limit) return { value };
  const kind = typeof value === "string" ? "" : " (JSON)";
  return {
    value: text.slice(0, limit),
    note: `truncated by session-host${kind}: ${text.length} chars -> ${limit}`,
  };
}

export function truncated(value, limit = TRUNCATE_LIMIT) {
  return cutRow(rowText(value), value, limit);
}

export function cutWithOverflow(value, limit = TRUNCATE_LIMIT) {
  const text = rowText(value);
  const cut = cutRow(text, value, limit);
  if (!cut.note) return cut;
  return { ...cut, overflow: overflowFor(text) };
}
