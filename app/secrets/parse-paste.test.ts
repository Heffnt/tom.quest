// The /secrets paste reader (parse-paste.ts): each case is a line as it might
// sit in a notes file, and what the box will be sent for it.

import { describe, expect, it } from "vitest";
import { parsePaste } from "./parse-paste";

function sent(text: string) {
  return parsePaste(text).secrets.map(({ name, value }) => [name, value]);
}

describe("parsePaste", () => {
  it("reads one secret per NAME=VALUE line, numbering lines from 1", () => {
    expect(parsePaste("A=1\nB=2")).toEqual({
      secrets: [
        { line: 1, name: "A", value: "1" },
        { line: 2, name: "B", value: "2" },
      ],
      refused: [],
    });
  });

  it("skips blank lines and lines starting with #, indented ones too", () => {
    expect(parsePaste("\n# a comment\n   \n  # indented comment\nA=1\n\r\n")).toEqual({
      secrets: [{ line: 5, name: "A", value: "1" }],
      refused: [],
    });
  });

  it("drops a leading export", () => {
    expect(sent("export A=1\nexport   B=2")).toEqual([
      ["A", "1"],
      ["B", "2"],
    ]);
  });

  it("takes one layer of matching single or double quotes off the value", () => {
    expect(sent(`A="one two"\nB='three'\nC="'kept'"\nD="unclosed\nE=mid"dle`)).toEqual([
      ["A", "one two"],
      ["B", "three"],
      ["C", "'kept'"],
      ["D", '"unclosed'],
      ["E", 'mid"dle'],
    ]);
  });

  it("tolerates whitespace around the =", () => {
    expect(sent("A = 1\nB\t=\t2\n  C=3  ")).toEqual([
      ["A", "1"],
      ["B", "2"],
      ["C", "3"],
    ]);
  });

  it("keeps every = after the first in the value", () => {
    expect(sent("TOKEN=abc==\nURL=https://x.test/?a=1&b=2")).toEqual([
      ["TOKEN", "abc=="],
      ["URL", "https://x.test/?a=1&b=2"],
    ]);
  });

  it("keeps a # inside a value, quoted or not", () => {
    expect(sent("A=abc#def\nB=abc #def\nC=\"#hash\"")).toEqual([
      ["A", "abc#def"],
      ["B", "abc #def"],
      ["C", "#hash"],
    ]);
  });

  it("accepts Windows line endings", () => {
    expect(sent("A=1\r\nB=2\r\n")).toEqual([
      ["A", "1"],
      ["B", "2"],
    ]);
  });

  it("refuses a bad name, a line with no =, and an empty value, and never repeats the value", () => {
    const paste = [
      "lower_case=secret-one",
      "HAS-DASH=secret-two",
      "9STARTS_WITH_DIGIT=secret-three",
      "just some text secret-four",
      "EMPTY=",
      "QUOTED_EMPTY=\"\"",
      "=secret-five",
      "GOOD=fine",
    ].join("\n");
    const result = parsePaste(paste);
    expect(result.secrets).toEqual([{ line: 8, name: "GOOD", value: "fine" }]);
    expect(result.refused.map((r) => [r.line, r.name])).toEqual([
      [1, undefined],
      [2, undefined],
      [3, undefined],
      [4, undefined],
      [5, "EMPTY"],
      [6, "QUOTED_EMPTY"],
      [7, undefined],
    ]);
    expect(JSON.stringify(result.refused)).not.toMatch(/secret-/);
  });

  it("sends the later of two lines with one name and refuses the earlier", () => {
    const result = parsePaste("A=old\nB=2\nA=new");
    expect(result.secrets).toEqual([
      { line: 2, name: "B", value: "2" },
      { line: 3, name: "A", value: "new" },
    ]);
    expect(result.refused).toEqual([{ line: 1, name: "A", reason: "repeated on line 3, which wins", superseded: true }]);
  });

  it("lets a later empty line win over an earlier value, sending nothing for that name", () => {
    const result = parsePaste("A=old\nA=");
    expect(result.secrets).toEqual([]);
    expect(result.refused).toEqual([
      { line: 1, name: "A", reason: "repeated on line 2, which wins", superseded: true },
      { line: 2, name: "A", reason: "value is empty" },
    ]);
  });

  it("reads nothing from an empty paste", () => {
    expect(parsePaste("")).toEqual({ secrets: [], refused: [] });
  });
});
