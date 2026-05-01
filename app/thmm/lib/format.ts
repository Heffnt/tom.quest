/**
 * Display formatters and parsers for register / RAM cell values. The CPU
 * stores everything as bit strings of fixed width; the UI lets the user
 * see and type values in decimal, hex, binary, or ASCII.
 */

import { type Bits, fromInt, parseValue, toSint, toUint } from "../cpu";

export type ViewMode = "dec" | "hex" | "ascii" | "bin";

export function displayBits(bits: Bits, mode: ViewMode): string {
  switch (mode) {
    case "dec":   return toSint(bits).toString();
    case "hex":   return "0x" + toUint(bits).toString(16).toUpperCase().padStart(Math.ceil(bits.length / 4), "0");
    case "bin":   return "0b" + bits;
    case "ascii": {
      const code = toUint(bits) & 0xff;
      if (code >= 32 && code <= 126) return String.fromCharCode(code);
      return "·";
    }
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

export function pad2Hex(n: number): string {
  return n.toString(16).padStart(2, "0").toUpperCase();
}
