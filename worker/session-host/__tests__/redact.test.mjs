// The credential filter (worker/session-host/redact.mjs): the one thing that
// stands between a token a model printed and a transcript row that lives
// forever. The behavior half imports the module; the wiring half reads lib.mjs
// as TEXT (it imports the worker-env symlink and cannot be loaded here) to pin
// that the filter is applied at the single ingest choke point, after the cut.
//
// This directory is deliberately NOT flat: setup.sh installs the daemon with
// `cp worker/session-host/*.mjs`, so this file never ships.
//
// Every "token" below is a made-up value of a REAL shape, and each one is
// assembled at runtime from split pieces by `t()`: no committed LINE spells a
// whole token, so the repo's gitleaks scan has nothing to flag and the test
// fencing the leak cannot become one.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { redactSecrets } from "../redact.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const libSource = fs.readFileSync(path.join(here, "..", "lib.mjs"), "utf8");

// The 32KB cut has ONE home (TRUNCATE_LIMIT in lib.mjs); read it from there
// rather than writing 32768 down a second time.
const TRUNCATE_LIMIT =
  Number(/TRUNCATE_LIMIT = (\d+) \* 1024/.exec(libSource)[1]) * 1024;

/** Join split pieces into one token-shaped string at runtime. */
const t = (...parts) => parts.join("");

const SHAPES = [
  ["github", t("gh", "p_", "A".repeat(36))],
  ["github", t("gh", "o_", "b3Kq9zX".repeat(5), "x")],
  ["github", t("gh", "u_", "C".repeat(36))],
  ["github", t("gh", "s_", "D".repeat(36))],
  ["github", t("gh", "r_", "E".repeat(36))],
  ["github", t("github", "_pat_11ABCDEFG0", "hJkLmNoPqRsTuVwXyZ".repeat(2))],
  ["slack", t("xox", "b-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx")],
  ["slack", t("xox", "p-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx")],
  ["slack", t("xox", "a-2-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUv")],
  ["slack", t("xox", "r-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx")],
  ["slack", t("xapp", "-1-A01BCDEFGHI-1234567890123-abcdef0123456789abcdef")],
  ["anthropic", t("sk-", "ant-api03-", "Zz9".repeat(20), "-AAAA")],
  ["openai", t("sk-", "proj-", "Qw3rTy8".repeat(6))],
  ["openai", t("sk-", "9".repeat(48))],
  ["aws", t("AK", "IAMOCK7EXAMPLE1234")],
  ["google", t("AI", "zaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW")],
  ["convex", t("prod", ":fictional-armadillo-000|", "ey", "J2MiI6ImEtZmFrZS1kZXBsb3kta2V5In0=")],
];

describe("redactSecrets replaces every credential shape", () => {
  for (const [kind, token] of SHAPES) {
    it(`redacts a ${kind} token (${token.slice(0, 8)}…)`, () => {
      const out = redactSecrets(`the value is ${token} and that is that`);
      expect(out).toContain(`[redacted:${kind}]`);
      expect(out).not.toContain(token);
      // Only the token goes; the sentence around it survives.
      expect(out).toBe(`the value is [redacted:${kind}] and that is that`);
    });
  }

  it("redacts an Authorization: Bearer value it has no named shape for", () => {
    const value = t("aB3dEf", ".gH1jKl-mN0pQr_sT2uV3w");
    const out = redactSecrets(`curl -H "Authorization: Bearer ${value}" https://x`);
    expect(out).toBe('curl -H "Authorization: Bearer [redacted:bearer]" https://x');
    expect(out).not.toContain(value);
  });

  it("names the real kind when a Bearer value is a known shape", () => {
    const out = redactSecrets("Authorization: Bearer gho_" + "Z".repeat(36));
    expect(out).toBe("Authorization: Bearer [redacted:github]");
  });

  it("redacts every token in a message that carries several", () => {
    const out = redactSecrets(
      `export GH_TOKEN=gho_${"Q".repeat(36)}\nexport SLACK=${t("xox", "b-1-2-abcdefghijklmnop")}`,
    );
    expect(out).toBe(
      "export GH_TOKEN=[redacted:github]\nexport SLACK=[redacted:slack]",
    );
  });

  it("redacts an AWS secret access key when its access ID precedes it", () => {
    const accessId = t("AK", "IA", "1234567890ABCDEF");
    const secret = t("Ab1dE2fG3hI4jK5l", "Mn6oP7qR8sT9uV0w", "XyZ1+/aB");
    const out = redactSecrets(`${accessId}: ${secret}`);

    expect(out).toBe("[redacted:aws]: [redacted:aws]");
    expect(out).not.toContain(accessId);
    expect(out).not.toContain(secret);
  });

  it("redacts an AWS secret access key across the access-ID line boundary", () => {
    const accessId = t("AK", "IA", "FEDCBA0987654321");
    const secret = t("Qw1eR2tY3uI4oP5a", "Sd6fG7hJ8kL9zX0c", "Vb2nM3qW");
    const out = redactSecrets(`${accessId}\n${secret}`);

    expect(out).toBe("[redacted:aws]\n[redacted:aws]");
    expect(out).not.toContain(accessId);
    expect(out).not.toContain(secret);
  });
});

describe("redactSecrets keeps named secret keys while removing their values", () => {
  const value = t("r4Nd0m", "-Secret_Value.1234567890-abcdefghijklmnopqrstuvwxyz");
  const CASES = [
    ["equals assignment", "password", `password=${value}`, "[redacted:secret]"],
    ["colon assignment", "passwd", `passwd: ${value}`, "[redacted:secret]"],
    ["JSON key and value", "client_secret", `{"client_secret":"${value}"}`, "[redacted:secret]"],
    ["upper-case environment name", "AWS_SECRET_ACCESS_KEY", `AWS_SECRET_ACCESS_KEY=${value}`, "[redacted:aws]"],
    ["authorization assignment", "AUTHORIZATION", `AUTHORIZATION=${value}`, "[redacted:secret]"],
    ["named high-entropy value", "token", `token ${value}`, "[redacted:secret]"],
  ];

  for (const [name, key, input, marker] of CASES) {
    it(`redacts a ${name}`, () => {
      const out = redactSecrets(input);
      expect(out).toContain(key);
      expect(out).toContain(marker);
      expect(out).not.toContain(value);
    });
  }

  it("keeps quoted JSON valid after replacing its value", () => {
    const out = redactSecrets(`{"api_key":"${value}","ordinary":"kept"}`);
    expect(JSON.parse(out)).toEqual({ api_key: "[redacted:secret]", ordinary: "kept" });
  });

  it("redacts an entire PEM private-key block", () => {
    const body = [
      t("-----BEGIN", " PRIVATE KEY-----"),
      t("MIIE", "vFakePrivateKeyMaterial0123456789"),
      t("-----END", " PRIVATE KEY-----"),
    ].join("\n");
    const out = redactSecrets(`before\n${body}\nafter`);
    expect(out).toBe("before\n[redacted:pem]\nafter");
    expect(out).not.toContain("FakePrivateKeyMaterial");
  });
});

describe("redactSecrets leaves ordinary text alone", () => {
  const INNOCENT = [
    "the risk-averse plan wins",
    "a task-oriented refactor",
    "ghp is not a token and neither is ghp_short",
    "sk-1 sk-ab sk-short-thing",
    "prod:fictional-armadillo-000 is a deployment name, not a key",
    "AKIA is four letters",
    "AIza on its own says nothing",
    "xoxb- with nothing after it",
    "Authorization: Bearer <token>",
    `token ${"a".repeat(40)}`,
    "we discussed sk- prefixes and gh_ prefixes at length",
  ];
  for (const text of INNOCENT) {
    it(`passes through: ${text}`, () => {
      expect(redactSecrets(text)).toBe(text);
    });
  }
});

describe("the marker and the 32KB cut", () => {
  it("a message that is nothing but a token becomes only the marker", () => {
    expect(redactSecrets("gho_" + "F".repeat(36))).toBe("[redacted:github]");
  });

  it("the marker survives the cut — redaction runs after it, on the final bytes", () => {
    const token = "gho_" + "G".repeat(36);
    // A runaway tool result: the token near the front, megabytes of noise
    // after it. session.mjs cuts to TRUNCATE_LIMIT, then sessionsFetch
    // serializes and redacts, so the marker is written into text that has
    // already been sliced and nothing can chop it.
    const huge = `token=${token} ` + "x".repeat(TRUNCATE_LIMIT * 2);
    const cut = huge.slice(0, TRUNCATE_LIMIT);
    const out = redactSecrets(JSON.stringify({ content: cut }));
    expect(out).toContain("[redacted:github]");
    expect(out).not.toContain(token);
    expect(out.endsWith('xxx"}')).toBe(true);
    // Still valid JSON: no replaced span ever contains an escape character.
    expect(JSON.parse(out).content.startsWith("token=[redacted:github] ")).toBe(true);
  });

  it("a token the cut lands inside leaves no whole token behind", () => {
    const token = "gho_" + "H".repeat(36);
    const head = "y".repeat(TRUNCATE_LIMIT - 20) + token;
    const out = redactSecrets(head.slice(0, TRUNCATE_LIMIT));
    expect(out).not.toContain(token);
  });
});

describe("wiring: the filter is applied at the ingest choke point", () => {
  it("lib.mjs re-exports it from redact.mjs", () => {
    expect(libSource).toMatch(
      /export \{ redactSecrets \} from "\.\/redact\.mjs"/,
    );
  });

  it("sessionsFetch redacts the serialized body", () => {
    expect(libSource).toMatch(/body: redactSecrets\(JSON\.stringify\(body\)\),/);
  });

  it("no unredacted JSON.stringify body survives in lib.mjs", () => {
    expect(libSource).not.toMatch(/body: JSON\.stringify\(body\)/);
  });

  it("the daemon has no second door to Convex to leak through", () => {
    // Every write goes through sessionsFetch; sessionsGet is a read with no
    // body. If a third `fetch(` appears here, it needs the filter too.
    expect(libSource.match(/await fetch\(/g)).toHaveLength(2);
  });
});
