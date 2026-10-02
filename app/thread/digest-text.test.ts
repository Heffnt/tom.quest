import { describe, expect, it } from "vitest";
import { slackSegments } from "./digest-text";

describe("slackSegments", () => {
  it("turns an https link with a label into a link segment", () => {
    expect(slackSegments("Read <https://example.com|the page>."))
      .toEqual([
        { text: "Read " },
        { text: "the page", href: "https://example.com" },
        { text: "." },
      ]);
  });

  it("uses the url as the label when Slack supplies none", () => {
    expect(slackSegments("<https://example.com/path>"))
      .toEqual([{ text: "https://example.com/path", href: "https://example.com/path" }]);
  });

  it("undoes Slack's three text escapes", () => {
    expect(slackSegments("A &amp; B &lt; C &gt; D <https://example.com|A &amp; B>"))
      .toEqual([
        { text: "A & B < C > D " },
        { text: "A & B", href: "https://example.com" },
      ]);
  });

  it("leaves a non-https url as plain text", () => {
    expect(slackSegments("See <http://example.com|there>"))
      .toEqual([{ text: "See <http://example.com|there>" }]);
  });

  it("leaves ordinary text unchanged", () => {
    expect(slackSegments("Nothing special here."))
      .toEqual([{ text: "Nothing special here." }]);
  });

  it("segments several links across several lines", () => {
    expect(slackSegments("- <https://one.example|One>\nThen </two> and <https://three.example>."))
      .toEqual([
        { text: "- " },
        { text: "One", href: "https://one.example" },
        { text: "\nThen " },
        { text: "/two", href: "/two" },
        { text: " and " },
        { text: "https://three.example", href: "https://three.example" },
        { text: "." },
      ]);
  });
});
