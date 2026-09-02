/**
 * Display formatters and parsers for register / RAM cell values. The CPU
 * stores everything as bit strings of fixed width; the UI lets the user
 * see and type values in decimal, hex, binary, or ASCII.
 */

import { type Bits, fromInt, parseValue, toSint, toUint } from "../cpu";

export type ViewMode = "dec" | "hex" | "ascii" | "bin";

/**
 * One printable character for a byte: the character itself for the printable
 * ASCII range (space through ~), and U+00B7 for everything else, so a column
 * of them stays one glyph per byte. Lifted out of displayBits's ascii branch
 * because the IO panel shows the same bytes from a number rather than from a
 * Bits string — the alternative was a third copy of the 32..126 rule.
 */
export function asciiChar(code: number): string {
  if (code >= 32 && code <= 126) return String.fromCharCode(code);
  return "·";
}

export function displayBits(bits: Bits, mode: ViewMode): string {
  switch (mode) {
    case "dec":   return toSint(bits).toString();
    case "hex":   return "0x" + toUint(bits).toString(16).toUpperCase().padStart(Math.ceil(bits.length / 4), "0");
    case "bin":   return "0b" + bits;
    case "ascii": return asciiChar(toUint(bits) & 0xff);
  }
}

/**
 * Parse a string the user typed into a Bits value of the given width. ASCII
 * mode treats the first character of the input as a literal byte. All other
 * modes go through the cpu's parseValue helper (decimal / 0xHEX / 0bBIN).
 */
export function parseInput(input: string, width: number, mode: ViewMode): Bits | null {
  if (mode === "ascii") {
    if (input.length === 0) return null;
    const code = input.charCodeAt(0);
    if (code > 0xff) return null;
    return fromInt(code, width);
  }
  return parseValue(input, width);
}
