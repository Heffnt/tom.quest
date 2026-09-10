// poll-outlook.mjs is a skeleton — its Microsoft Graph half lands with Tom's
// credential — so what can be checked is what was decidable without the token:
// the three keys it refuses to run without, and the two strings a later reader
// depends on. Both are already spelled in worker.env.example and in the
// commented-out cron line, so a rename here that misses one of those is what
// this file catches.
//
// Importing the job module is safe: it only calls main() when node was pointed
// at the file (the `invokedDirectly` guard at the bottom of poll-outlook.mjs).
import { describe, expect, it } from "vitest";
// A plain-JS worker job (deployed to the Jarvis Box as .mjs); the test reads
// its pure exports, which TypeScript infers straight from the source.
import {
  OUTLOOK_KEYS,
  messageProvenance,
  messageSourceId,
  missingKeys,
} from "./poll-outlook.mjs";

describe("the credential the job waits for", () => {
  it("names exactly the three OUTLOOK_* keys worker.env.example documents", () => {
    expect(OUTLOOK_KEYS).toEqual([
      "OUTLOOK_CLIENT_ID",
      "OUTLOOK_CLIENT_SECRET",
      "OUTLOOK_REFRESH_TOKEN",
    ]);
  });

  it("reports every absent key, so one line says what is still missing", () => {
    expect(missingKeys({})).toEqual(OUTLOOK_KEYS);
    expect(
      missingKeys({ OUTLOOK_CLIENT_ID: "id", OUTLOOK_CLIENT_SECRET: "secret" }),
    ).toEqual(["OUTLOOK_REFRESH_TOKEN"]);
    // An empty string is not a filled-in key — worker.env ships with the
    // three names present and blank.
    expect(missingKeys({ OUTLOOK_CLIENT_ID: "" })).toEqual(OUTLOOK_KEYS);
  });

  it("is configured only when all three are there", () => {
    expect(
      missingKeys({
        OUTLOOK_CLIENT_ID: "id",
        OUTLOOK_CLIENT_SECRET: "secret",
        OUTLOOK_REFRESH_TOKEN: "token",
      }),
    ).toEqual([]);
  });
});

describe("the stable source id of an Outlook mail", () => {
  it("names the message id first, then the link", () => {
    expect(messageSourceId("AAMkAD")).toBe("outlook:message:AAMkAD");
    expect(messageProvenance("AAMkAD", "https://outlook.office.com/mail/id/AAMkAD")).toBe(
      "outlook:message:AAMkAD https://outlook.office.com/mail/id/AAMkAD",
    );
    // No webLink in the payload still leaves an id to identify the row by.
    expect(messageProvenance("AAMkAD", "")).toBe("outlook:message:AAMkAD");
  });
});
