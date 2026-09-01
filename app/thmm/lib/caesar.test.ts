/**
 * The `int c<i> = <byte>;` source format has one writer (buildCaesarSource)
 * and one reader (caesarCipherFromSource), and these tests hold them to each
 * other. The rule used to be spelled in three files — caesar.ts wrote it,
 * scenarios.ts and io-panel.tsx each parsed it back with a private copy of the
 * regex — so a change to the writer could leave two readers wrong with nothing
 * failing.
 */

import { describe, expect, it } from "vitest";
import { buildCaesarSource, caesarCipherFromSource, decryptCaesar } from "./caesar";

describe("caesarCipherFromSource", () => {
  it("reads back exactly what buildCaesarSource baked in", () => {
    for (const cipher of ["WRP KHIIHUQDQ", "A", "HELLO WORLD", ""]) {
      expect(caesarCipherFromSource(buildCaesarSource(cipher))).toBe(cipher);
    }
  });

  it("orders bytes by their c-index, not by line order", () => {
    const source = ["int c2 = 67;", "int c0 = 65;", "int c1 = 66;"].join("\n");
    expect(caesarCipherFromSource(source)).toBe("ABC");
  });

  it("reads a source with no c-lines as empty rather than throwing", () => {
    expect(caesarCipherFromSource("int x = 5;\nint y = x + 1;")).toBe("");
  });

  it("round-trips through the decryption the Execute scene shows", () => {
    const source = buildCaesarSource("WRP KHIIHUQDQ");
    expect(decryptCaesar(caesarCipherFromSource(source))).toBe("TOM HEFFERNAN");
  });
});
