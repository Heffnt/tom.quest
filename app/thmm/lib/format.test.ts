/**
 * asciiChar was lifted out of displayBits's ascii branch so the IO panel could
 * call it with a byte instead of keeping its own printableOrDot copy. These
 * tests hold the extraction to the branch it came from, and hold toSint to the
 * width-16 rule the panel used to hardcode as 0x8000 / 0x10000.
 */

import { describe, expect, it } from "vitest";
import { fromInt, toSint } from "../cpu";
import { asciiChar, displayBits } from "./format";

describe("asciiChar", () => {
  it("agrees with displayBits's ascii mode on every byte", () => {
    for (let code = 0; code <= 255; code++) {
      expect(asciiChar(code)).toBe(displayBits(fromInt(code, 16), "ascii"));
    }
  });

  it("prints the printable range as itself and everything else as one dot", () => {
    expect(asciiChar(32)).toBe(" ");
    expect(asciiChar(65)).toBe("A");
    expect(asciiChar(126)).toBe("~");
    expect(asciiChar(31)).toBe("·");
    expect(asciiChar(127)).toBe("·");
    expect(asciiChar(-1)).toBe("·");
  });
});

describe("toSint at width 16", () => {
  it("signs the boundaries the IO panel used to hardcode", () => {
    expect(toSint(fromInt(0x7fff, 16))).toBe(32767);
    expect(toSint(fromInt(0x8000, 16))).toBe(-32768);
    expect(toSint(fromInt(0xffff, 16))).toBe(-1);
    expect(toSint(fromInt(0, 16))).toBe(0);
  });
});
