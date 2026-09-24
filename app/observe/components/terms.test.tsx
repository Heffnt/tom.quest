// Every vocabulary word in a piece of the record's own text is found and made
// clickable, and nothing else is.

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import Terms, { TermsProvider, split } from "./terms";

afterEach(() => cleanup());

describe("splitting a sentence", () => {
  it("finds the vocabulary's words and leaves the rest alone", () => {
    const parts = split("the worker wrote a ruling into the record");
    const terms = parts.filter((part) => part.term !== null).map((part) => part.term);
    expect(terms).toEqual(["worker", "ruling", "record"]);
    expect(parts.map((part) => part.text).join("")).toBe(
      "the worker wrote a ruling into the record",
    );
  });

  it("finds a plural and asks about the word itself", () => {
    const parts = split("two runs and three goals");
    expect(parts.filter((part) => part.term !== null).map((part) => part.term)).toEqual([
      "run",
      "goal",
    ]);
  });

  it("prefers the longer word where two overlap", () => {
    const parts = split("the Jarvis Box is on");
    expect(parts.filter((part) => part.term !== null).map((part) => part.term)).toEqual([
      "Jarvis Box",
    ]);
  });

  it("does not find a word inside another word", () => {
    expect(split("rerun the workaround").every((part) => part.term === null)).toBe(true);
  });
});

describe("the rendered text", () => {
  it("asks for the word the reader pressed", () => {
    const asked: string[] = [];
    const { getByText } = render(
      <TermsProvider onDefine={(term) => asked.push(term)}>
        <Terms text="one ruling" />
      </TermsProvider>,
    );
    fireEvent.click(getByText("ruling"));
    expect(asked).toEqual(["ruling"]);
  });
});
