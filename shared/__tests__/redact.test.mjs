// The credential filter (shared/redact.mjs): the one thing that stands between
// a token a model printed and a transcript row that lives forever. This file is
// its behavior. The wiring, that the daemon applies it at the single ingest
// choke point after the cut, is the Jarvis repository's
// worker/session-host/__tests__/redact-wiring.test.mjs.
//
// Every "token" below is a made-up value of a REAL shape, and each one is
// assembled at runtime from split pieces by `t()`: no committed LINE spells a
// whole token, so the repo's gitleaks scan has nothing to flag and the test
// fencing the leak cannot become one.

import { describe, expect, it } from "vitest";

import { countOpenKeyBlockReads, LINE_CROSSING_RULES, OPEN_KEY_BLOCK, openPrivateKeyLineStart, REDACTED_SHAPES, redactSecrets } from "../redact.mjs";

// The parser's cut, TRUNCATE_LIMIT, is 32KB and lives in the Jarvis
// repository (worker/agents/cut.mjs). Here it is a fixture: what these cases state is
// that redaction runs on the bytes after a cut, wherever the cut falls.
const TRUNCATE_LIMIT = 32 * 1024;

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
    // `auth_token`, not the bare word: see "the name list is narrow" below.
    ["named high-entropy value", "auth_token", `auth_token ${value}`, "[redacted:secret]"],
    ["escaped JSON key and value", "api_key", `{\\"api_key\\":\\"${value}\\"}`, "[redacted:secret]"],
    ["escaped quoted value", "GITHUB_TOKEN", `GITHUB_TOKEN=\\"${value}\\"`, "[redacted:secret]"],
    ["single-quoted value", "password", `password='${value}'`, "[redacted:secret]"],
    ["upper-case environment name with no vendor rule", "TTS_WORKER_KEY", `TTS_WORKER_KEY=${value}`, "[redacted:secret]"],
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

// The 2026-09-11 fix, in two halves. The first is a CORRECTNESS fence, not a
// secrecy one: the daemon redacts `JSON.stringify(body)` (lib.mjs), so a
// replacement that eats a closing quote makes the ingest POST malformed, Convex
// answers 400, and session.mjs — which treats 400 as permanent — drops the row.
describe("a replacement inside a serialized body never breaks the JSON", () => {
  const value = t("r4Nd0m", "-Secret_Value.1234567890-abcdefghijklmnop");
  const CASES = [
    ["a value mid-string", `export GITHUB_TOKEN=${value} && gh pr list`],
    ["a value at the very end of the string", `export GITHUB_TOKEN=${value}`],
    ["a value followed by an escaped quote", `GITHUB_TOKEN=${value}" is the token`],
    ["a quoted value, whose quotes are escapes", `password="${value}"`],
    ["a JSON blob a tool printed", JSON.stringify({ api_key: value, ordinary: "kept" })],
    ["a value carrying an escape of its own", `GITHUB_TOKEN=${value}\\n next`],
  ];

  for (const [name, content] of CASES) {
    it(`stays parseable with ${name}`, () => {
      const out = redactSecrets(JSON.stringify({ command: content }));
      expect(() => JSON.parse(out)).not.toThrow();
      expect(JSON.parse(out).command).toContain("[redacted:secret]");
      expect(out).not.toContain(value);
    });
  }

  // The audit's counterexample, 2026-09-11. A name at the END of a string
  // leaves the quoted value form free to open on the quote that CLOSES that
  // string and shut on the one that OPENS the next — swallowing the structure
  // between them, which in a mixed array is long and digit-heavy enough to
  // read as a credential. The values these forms take must be fenced by the
  // characters JSON structure is made of, not only by the name in front.
  const STRUCTURE = [
    ["a mixed array whose element ends in a name", '["password:",1757600000000,"ok"]'],
    ["an object whose value ends in a name", '{"note":"the password:","timeout":120000}'],
    ["an apostrophe that is not a quoted value", `{"note":"password='abc123\\",\\"timeout\\":120000,x'"}`],
    ["a name at the end of an array element", '["export GITHUB_TOKEN=",1757600000000,"ok"]'],
  ];
  for (const [name, text] of STRUCTURE) {
    it(`leaves the structure alone: ${name}`, () => {
      const out = redactSecrets(text);
      expect(() => JSON.parse(out)).not.toThrow();
      expect(out).toBe(text);
    });
  }
});

// The second half: the name list is narrow enough that the filter does not
// redact ordinary content. It cost an eval regression and a broken ingest to
// learn that `token` and `key` are words this system uses for its own data.
describe("the name list is narrow: a name alone does not make a value a secret", () => {
  const UNTOUCHED = [
    'key: "learning:abc"',
    '{"key":"learning:abc"}',
    '{"key":"ground.md#Knows"}',
    '{"token":"j57turn1"}',
    "tokens=5000",
    "token = the smallest unit",
    "a token is the smallest unit a model bills in",
    "PWD=/root/x",
    "pwd=/root/tom.quest",
    "secret: not-configured",
    "monkey=banana",
    "password: short",
    "api_key: /etc/tts/worker.env",
  ];
  for (const text of UNTOUCHED) {
    it(`leaves alone: ${text}`, () => {
      expect(redactSecrets(text)).toBe(text);
    });
  }

  const REDACTED = [
    ["a GitHub token in an export", `export GITHUB_TOKEN=${t("gh", "p_", "K".repeat(36))}`, "[redacted:github]"],
    ["a short but credential-shaped password", "password: hunter2secret1", "[redacted:secret]"],
    ["an API key under its JSON name", `{"api_key":"${t("sk-", "proj-", "Zx9wQ7v".repeat(6))}"}`, "[redacted:openai]"],
    ["an AWS secret after its access ID", `${t("AK", "IA", "1122334455667788")}: ${t("Ab1dE2fG3hI4jK5l", "Mn6oP7qR8sT9uV0w", "XyZ1+/aB")}`, "[redacted:aws]"],
    ["an AWS environment name", `AWS_SECRET_ACCESS_KEY=${t("Ab1dE2fG3hI4jK5l", "Mn6oP7qR8sT9uV0w", "XyZ1+/aB")}`, "[redacted:aws]"],
    ["a Convex deploy key", t("prod", ":fictional-armadillo-000|", "ey", "J2MiI6ImEtZmFrZS1kZXBsb3kta2V5In0="), "[redacted:convex]"],
    ["a PEM block", [t("-----BEGIN", " PRIVATE KEY-----"), "MIIEvFake0123456789", t("-----END", " PRIVATE KEY-----")].join("\n"), "[redacted:pem]"],
  ];
  for (const [name, text, marker] of REDACTED) {
    it(`still redacts ${name}`, () => {
      const out = redactSecrets(text);
      expect(out).toContain(marker);
      // Nothing 12 characters or longer of the input survives beside the marker.
      expect(out).not.toBe(text);
    });
  }
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

// openPrivateKeyLineStart is how a caller that sends text a line at a time
// (the Jarvis box's live tail) knows where a private key block the filter
// would leave open begins, without spelling the filter's rule a second time.
// Held to the filter on the cases the Jarvis fence test uses: every armour
// label, and every arrangement of first and last lines. For each, the answer
// is -1 exactly when the filter closes every block; otherwise it is a line
// start, the text before it redacts with no block left open, and every later
// line start leaves one open.
describe("openPrivateKeyLineStart agrees with the filter's private-key rule", () => {
  const edge = (kind, label) => t("-----", kind, label, " PRIVATE KEY-----");
  // A block is left open when a last line appended would change how the
  // text's own part redacts: the filter then takes the block whole instead of
  // as far as the lines a key's body can be.
  const closing = t("-----END", " PRIVATE KEY-----");
  const leftOpen = (text) => redactSecrets(`${text}\n${closing}`) !== `${redactSecrets(text)}\n${closing}`;
  const lineStarts = (text) => [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)];
  for (const label of ["", " RSA", " EC", " DSA", " OPENSSH", " ENCRYPTED", " X9 62"]) {
    const [b, e] = [edge("BEGIN", label), edge("END", label)];
    const arrangements = [
      [b, "MIIbody0123", e],
      [b, "MIIbody0123"],
      [`see ${b} here`, "MIIbody0123", `and ${e} there`],
      [`see ${b} here`, "MIIbody0123"],
      [b, "MIIbody", b, "MIIbody", e],
      [b, "MIIbody", e, "text", b, "MIIbody"],
      [b, "MIIbody", e, b, "MIIbody", e],
      [e, "text"],
      [e, b, "MIIbody"],
      [b, "MIIbody", edge("END", " OTHER LABEL")],
      [`${b} MIIbody ${e}`],
      [`${b} MIIbody`, `${e} ${b}`],
    ];
    for (const lines of arrangements) {
      it(`label "${label.trim()}": ${JSON.stringify(lines).slice(0, 80)}`, () => {
        const whole = `before\n${lines.join("\n")}\nafter\n`;
        const at = openPrivateKeyLineStart(whole);
        expect(at === -1).toBe(!leftOpen(whole));
        if (at === -1) return;
        expect(lineStarts(whole)).toContain(at);
        expect(leftOpen(whole.slice(0, at))).toBe(false);
        for (const later of lineStarts(whole).filter((start) => start > at)) {
          expect(leftOpen(whole.slice(0, later)), `line start ${later}`).toBe(true);
        }
      });
    }
  }
});

// LINE_CROSSING_RULES names the rules a line break can split. Each listed rule
// is shown redacting a secret whose parts sit on two lines; the rules not
// listed are shown not to: every REDACTED_SHAPES pattern has no construct that
// matches a line break, and a Bearer value on the line after its header is left
// alone.
describe("LINE_CROSSING_RULES lists the rules that match across a line break", () => {
  it("lists pem, aws-pair and named", () => {
    expect(LINE_CROSSING_RULES).toEqual(["pem", "aws-pair", "named"]);
  });

  const crossing = {
    pem: [t("-----BEGIN", " PRIVATE KEY-----"), t("MIIE", "vFakeKeyMaterial0123"), t("-----END", " PRIVATE KEY-----")].join("\n"),
    "aws-pair": `${t("AK", "IA", "FEDCBA0987654321")}\n${t("Qw1eR2tY3uI4oP5a", "Sd6fG7hJ8kL9zX0c", "Vb2nM3qW")}`,
    named: `AUTH_TOKEN:\n  ${t("Zx9Yw8Vu7", "Ts6Rq5Po4Nm")}`,
  };
  for (const kind of ["pem", "aws-pair", "named"]) {
    it(`${kind} redacts a secret split across two lines`, () => {
      const text = crossing[kind];
      const out = redactSecrets(text);
      expect(out).not.toBe(text);
      expect(out).toContain("[redacted:");
      for (const line of text.split("\n").slice(1)) expect(out).not.toContain(line.trim());
    });
  }

  it("no REDACTED_SHAPES pattern can match a line break", () => {
    for (const { pattern } of REDACTED_SHAPES) {
      expect(/\\s|\\n|\\r|\[\\s\\S\]|(^|[^\\])\.|\[\^/.test(pattern.source), pattern.source).toBe(false);
    }
  });

  it("a Bearer value on the line after its header is left alone", () => {
    const text = `Authorization: Bearer\n${t("abcdefgh", "12345678")}`;
    expect(redactSecrets(text)).toBe(text);
  });
});

// A block whose last line never came: a log cut off, a process killed while it
// printed, a buffer stopped at its cap. The filter takes it from its first line
// over the lines a key's body can be (OPEN_KEY_BLOCK in redact.mjs), and no further.
// Each kind of line is shown taken, and the line after it shown kept. The
// bodies are made up: base64 of the alphabet, no key.
describe("a private key block left open", () => {
  const begin = t("-----BEGIN", " PRIVATE KEY-----");
  const BODY = t("QUJDREVGR0hJSktMTU5P", "UFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2");
  const LAST = "d3h5eg==";
  const KEPT = "and this sentence stays as it was";
  const shows = (text) => redactSecrets(text);

  it("takes full lines and the short last one, and keeps the line after", () => {
    expect(shows(["before", begin, BODY, BODY, LAST, KEPT].join("\n"))).toBe(`before\n[redacted:pem]\n${KEPT}`);
  });

  it("takes full and short lines behind a line number and tab, or a diff's sign", () => {
    const read = [`     1\t${begin}`, `     2\t${BODY}`, `     3\t${LAST}`, `     4\t${KEPT}`].join("\n");
    expect(shows(read)).toBe(`     1\t[redacted:pem]\n     4\t${KEPT}`);
    expect(shows([`-${begin}`, `-${BODY}`, `+${BODY}`, ` ${LAST}`, ` ${KEPT}`].join("\n"))).toBe(`-[redacted:pem]\n ${KEPT}`);
  });

  it("takes a full line behind any prefix, and keeps the line after", () => {
    const log = [begin, `2026-09-27T10:00:01Z stderr ${BODY}`, `2026-09-27T10:00:01Z stderr ${BODY}`, KEPT].join("\n");
    expect(shows(log)).toBe(`[redacted:pem]\n${KEPT}`);
  });

  it("takes a body folded onto the first line with spaces", () => {
    expect(shows(`${begin} ${BODY} ${BODY} ${LAST}\n${KEPT}`)).toBe(`[redacted:pem]\n${KEPT}`);
  });

  it("takes a body pasted as one long line", () => {
    expect(shows(`${begin}\n${BODY.repeat(20)}\n${KEPT}`)).toBe(`[redacted:pem]\n${KEPT}`);
  });

  it("takes a line holding a full commit id: the stated cost of the full line", () => {
    expect(shows(`${begin}\ncommit 0123456789abcdef0123456789abcdef01234567\n${KEPT}`)).toBe(`[redacted:pem]\n${KEPT}`);
  });

  it("takes header and empty lines before the first full line when one follows, and not otherwise", () => {
    const encrypted = [begin, "Proc-Type: 4,ENCRYPTED", "DEK-Info: AES-128-CBC,0A1B2C3D", "", BODY, KEPT].join("\n");
    expect(shows(encrypted)).toBe(`[redacted:pem]\n${KEPT}`);
    expect(shows([begin, "Proc-Type: 4,ENCRYPTED", "", KEPT].join("\n"))).toBe(`[redacted:pem]\nProc-Type: 4,ENCRYPTED\n\n${KEPT}`);
    // After the body has begun, an empty line ends it.
    expect(shows([begin, BODY, "", BODY].join("\n"))).toBe(`[redacted:pem]\n\n${BODY}`);
  });

  it("takes the text's cut-off last line: a partial body line, alone or behind a timestamp", () => {
    expect(shows(`${begin}\n${BODY}\nQUJD`)).toBe("[redacted:pem]");
    expect(shows(`${begin}\n2026-09-27T10:00:01Z ${BODY}\n2026-09-27T10:00:01Z QUJD`)).toBe("[redacted:pem]");
    expect(shows(`${begin}\n${BODY}\n${KEPT}`)).toBe(`[redacted:pem]\n${KEPT}`);
  });

  // The audit's case (tom.quest 315): a word after the first line is not a
  // key's first body line, which is always a full one.
  it("takes no short line directly after the first line when more text follows: only the marker goes", () => {
    expect(shows([begin, "x", KEPT].join("\n"))).toBe(`[redacted:pem]\nx\n${KEPT}`);
    expect(shows(`${begin} x\n${KEPT}`)).toBe(`[redacted:pem] x\n${KEPT}`);
  });

  it("takes one short line after full lines as the key's last, and ends the block with it", () => {
    expect(shows([begin, BODY, BODY, "Thanks", KEPT].join("\n"))).toBe(`[redacted:pem]\n${KEPT}`);
    expect(shows([begin, BODY, LAST, BODY].join("\n"))).toBe(`[redacted:pem]\n${BODY}`);
  });

  it("takes a short line directly after the first line when the text ends there", () => {
    expect(shows(`${begin}\nQUJD`)).toBe("[redacted:pem]");
  });

  it("reads CRLF, leading spaces and tabs as a line's edges", () => {
    expect(shows([begin, `  ${BODY}`, `\t${LAST}  `, KEPT].join("\r\n"))).toBe(`[redacted:pem]\r\n${KEPT}`);
  });

  it("takes only the first line's marker when prose follows it on that line, and keeps the lines after", () => {
    const doc = `A key file starts with ${begin} and then its body.\n${BODY}\n${KEPT}`;
    expect(shows(doc)).toBe(`A key file starts with [redacted:pem] and then its body.\n${BODY}\n${KEPT}`);
  });

  it("reads escaped line breaks and tabs inside a serialized string, and the JSON stays valid", () => {
    const once = JSON.stringify({ output: [`     1\t${begin}`, `     2\t${BODY}`, `     3\t${LAST}`].join("\n"), next: KEPT });
    const out = shows(once);
    expect(JSON.parse(out)).toEqual({ output: "     1\t[redacted:pem]", next: KEPT });
    const twice = JSON.stringify({ line: JSON.stringify({ key: [begin, BODY, LAST].join("\r\n") }) });
    const outTwice = shows(twice);
    expect(JSON.parse(JSON.parse(outTwice).line)).toEqual({ key: "[redacted:pem]" });
    expect(outTwice).not.toContain(BODY);
  });

  it("keeps the closing quote of a serialized string that ends inside the block", () => {
    const body = JSON.stringify({ text: `${begin}\n${BODY}\nQUJD`, after: [1, "ok"] });
    expect(JSON.parse(shows(body))).toEqual({ text: "[redacted:pem]", after: [1, "ok"] });
  });

  it("replaces whole blocks exactly as the whole-block rule over the whole text did, in any arrangement", () => {
    // The rule as it stood, run over the whole text: the reference.
    const rule = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g;
    const end = t("-----END", " PRIVATE KEY-----");
    const parts = [begin, end, BODY, KEPT, "x"];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % parts.length;
    for (let n = 0; n < 500; n += 1) {
      const lines = Array.from({ length: 1 + (n % 9) }, () => parts[next()]);
      const text = `${lines.join("\n")}\n${end}`;
      expect(shows(text), JSON.stringify(lines)).toBe(text.replace(rule, "[redacted:pem]"));
    }
  });

  it("leaves a whole block to the whole-block rule, prose between its lines and all", () => {
    const whole = [begin, BODY, KEPT, t("-----END", " PRIVATE KEY-----"), "after"].join("\n");
    expect(shows(whole)).toBe("[redacted:pem]\nafter");
  });
});

// The same blocks as a serializer writes them. The filter runs over serialized
// bodies (the daemon's request body, the sweep's raw lines, a JSON value inside
// a JSON string), so a block's lines are read with every escape decoded: the
// line break, the carriage return, the tab, the solidus, the quote and \u with
// four hex digits, once and twice escaped. Each block is checked raw and in
// every spelling, and a serialized one must still parse.
describe("a private key block left open, as a serializer spells it", () => {
  const begin = t("-----BEGIN", " PRIVATE KEY-----");
  const BODY = t("QUJD/EVGR0hJ+ktMTU5P", "UFFSU1RVVldYWVph/mNkZWZnaGlq+2xtbm9wcXJzdHV2");
  const LAST = "d3/5eg==";
  const KEPT = "and this sentence stays as it was";
  const unicode = (json) => json.replace(/[/+=]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).replace(/\\t/g, "\\u0009");
  const SPELLINGS = [
    ["raw", (text) => text, (out) => out],
    ["serialized once", (text) => JSON.stringify({ t: text }), (out) => JSON.parse(out).t],
    ["serialized once, solidus escaped", (text) => JSON.stringify({ t: text }).replace(/\//g, "\\/"), (out) => JSON.parse(out).t],
    ["serialized once, as \\u escapes", (text) => unicode(JSON.stringify({ t: text })), (out) => JSON.parse(out).t],
    ["serialized once, line breaks as \\u escapes", (text) => JSON.stringify({ t: text }).replace(/\\n/g, "\\u000a"), (out) => JSON.parse(out).t],
    ["serialized twice", (text) => JSON.stringify({ l: JSON.stringify({ t: text }) }), (out) => JSON.parse(JSON.parse(out).l).t],
    ["serialized twice, solidus escaped", (text) => JSON.stringify({ l: JSON.stringify({ t: text }).replace(/\//g, "\\/") }), (out) => JSON.parse(JSON.parse(out).l).t],
  ];
  const CASES = [
    ["full lines and the short last one", [begin, BODY, BODY, LAST, KEPT].join("\n"), `[redacted:pem]\n${KEPT}`],
    ["an encrypted block indented by tabs", [begin, "\tProc-Type: 4,ENCRYPTED", "\tDEK-Info: AES-128-CBC,0A1B2C3D", "\t", `\t${BODY}`, `\t${LAST}`, KEPT].join("\n"), `[redacted:pem]\n${KEPT}`],
    ["a short last line indented by a tab", [begin, `\t${BODY}`, `\t${LAST}`, KEPT].join("\n"), `[redacted:pem]\n${KEPT}`],
    ["lines behind line numbers and tabs", [`     1\t${begin}`, `     2\t${BODY}`, `     3\t${LAST}`, `     4\t${KEPT}`].join("\n"), `     1\t[redacted:pem]\n     4\t${KEPT}`],
    ["CRLF line breaks", [begin, BODY, LAST, KEPT].join("\r\n"), `[redacted:pem]\r\n${KEPT}`],
    ["a body folded onto the first line", `${begin} ${BODY} ${LAST}\n${KEPT}`, `[redacted:pem]\n${KEPT}`],
    ["a text cut off behind a timestamp", [begin, `2026-09-28T01:00Z ${BODY}`, "2026-09-28T01:00Z QU/D"].join("\n"), "[redacted:pem]"],
    ["a text cut off inside the first body line", `${begin}\nQU/D+E`, "[redacted:pem]"],
    ["a word after the first line, then prose", [begin, "x", KEPT].join("\n"), `[redacted:pem]\nx\n${KEPT}`],
    ["an empty line after the body", [begin, BODY, "", BODY].join("\n"), `[redacted:pem]\n\n${BODY}`],
  ];
  // Serialized twice, a cut-off text stops at the inner string's end, an
  // escaped quote, which is read as the text's end.
  for (const [name, text, shown] of CASES) {
    for (const [spelling, spell, read] of SPELLINGS) {
      it(`${name}, ${spelling}`, () => {
        const out = redactSecrets(spell(text));
        expect(read(out)).toBe(shown);
        if (!shown.includes(BODY)) expect(out).not.toContain("UFFSU1RVVldYWVph");
      });
    }
  }

  it("ends the block at a raw quote, the string's end, and keeps it: an escaped backslash before it is taken whole", () => {
    const body = JSON.stringify({ t: `${begin}\n${BODY}\\`, n: KEPT });
    expect(JSON.parse(redactSecrets(body))).toEqual({ t: "[redacted:pem]", n: KEPT });
  });

  it("ends the block at an escaped quote, read as the text's end, and never takes the quote", () => {
    for (const spell of [(json) => json, (json) => json.replace(/\\"/g, "\\u0022")]) {
      const body = spell(JSON.stringify({ t: [begin, BODY, `"quoted" ${KEPT}`].join("\n") }));
      expect(JSON.parse(redactSecrets(body))).toEqual({ t: `[redacted:pem]\n"quoted" ${KEPT}` });
      // A word directly after the first line, then the quote: the text's end, so it is taken.
      const first = spell(JSON.stringify({ t: [begin, `x "quoted" ${KEPT}`].join("\n") }));
      expect(JSON.parse(redactSecrets(first))).toEqual({ t: `[redacted:pem]"quoted" ${KEPT}` });
    }
  });

  it("reads a Windows path's backslash-n as a line break; `C:` is no line a block takes, so the path is left", () => {
    const text = `${begin} C:\\new\\keys\\a.pem\n${KEPT}`;
    expect(redactSecrets(text)).toBe(`[redacted:pem] C:\\new\\keys\\a.pem\n${KEPT}`);
    expect(redactSecrets([begin, "C:\\new\\temp", KEPT].join("\n"))).toBe(`[redacted:pem]\nC:\\new\\temp\n${KEPT}`);
  });

  it("reads a raw text's literal backslash-n as a line break after the first line", () => {
    expect(redactSecrets(`${begin}\\n${BODY}\\n${KEPT}`)).toBe(`[redacted:pem]\\n${KEPT}`);
  });
});

// The step's cost, counted, not timed: a time fails on a loaded machine. The
// count is every character the step looks at: the search for first lines (the
// text once), the line reader and the kinds of line. For each input that was
// slow on an earlier head of this change, and each worst case of the reader,
// the count stays under eight looks per character, and doubling the text at
// most doubles the count (with a margin).
describe("the open-block step looks at each character a bounded number of times", () => {
  const begin = t("-----BEGIN", " PRIVATE KEY-----");
  const BODY = t("QUJDREVGR0hJSktMTU5P", "UFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2");
  const fill = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const INPUTS = {
    // The audit's input on the third head: 4,000 first lines in 120 KB took 7 s.
    "first lines on one line": (n) => fill(`${begin} x `, n),
    "first lines on one line, serialized twice": (n) => JSON.stringify(JSON.stringify(fill(`${begin} \\ x\t`, n))),
    // Found by this change's builder on the third head: 38 s at 120 KB.
    "a full line, then blanks ending in a character no line kind takes": (n) => `${begin}\n${BODY}\n${" ".repeat(n)}!`,
    "first lines each before a long line": (n) => fill(`${begin}\n${"word ".repeat(200)}\n`, n),
    "one first line, then no line break": (n) => `${begin}${fill(BODY, n)}`,
    "one first line, then escapes": (n) => `${begin}${fill("\\\\\\u00", n)}`,
    "one first line, then line numbers": (n) => `${begin}\n${fill("12345678\t", n)}`,
  };
  for (const [name, make] of Object.entries(INPUTS)) {
    it(name, () => {
      const [small, large] = [make(30_000), make(60_000)];
      const [atSmall, atLarge] = [countOpenKeyBlockReads(small), countOpenKeyBlockReads(large)];
      expect(atSmall).toBeLessThan(8 * small.length);
      expect(atLarge).toBeLessThan(8 * large.length);
      expect(atLarge / atSmall).toBeLessThan(2.5);
    });
  }

  // A regular expression does its work where the count cannot see it, and the
  // 38-second input above was one. Every kind of line is a function that
  // looks at its line through the counter, and none holds a regular expression.
  it("has no kind of line that is a regular expression or runs one", () => {
    for (const [name, kind] of Object.entries(OPEN_KEY_BLOCK)) {
      expect(typeof kind, name).toBe("function");
      expect(String(kind), name).not.toMatch(/\.(?:test|exec|match|matchAll|search|replace|split)\(|RegExp/);
    }
  });
});

// A spelling that reads two ways is read the way that takes more: the filter is
// not told whether, or how often, its text was serialized, and it would rather
// take a word of ordinary text from a row that holds a key's first line than
// let a line of the key through. Each row is a choice this pins, and its cost.
describe("a spelling an open block's reader can read two ways", () => {
  const begin = t("-----BEGIN", " PRIVATE KEY-----");
  const BODY = t("QUJDREVGR0hJSktMTU5P", "UFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2");
  const J = (text) => JSON.stringify({ t: text });
  const shows = (json) => JSON.parse(redactSecrets(json)).t;
  const ROWS = [
    // The audit's own example (tom.quest 315, fifth head): two backslashes and
    // n are a literal backslash and n in a string serialized once, and a line
    // break in one serialized twice. Read as the line break, the word before
    // it is a short line after a full line: the key's last line, taken.
    ["two backslashes before n, serialized once: a Windows path after a full line loses the word before it",
      J(`${begin}\n${BODY}\nThanks\\new\\keys\\a.pem`), "[redacted:pem]\\new\\keys\\a.pem"],
    // Read as a tab, a blank: `Thanks` then a literal backslash-t is a short line.
    ["two backslashes before t, serialized once: a word ending in a literal backslash-t", J(`${begin}\n${BODY}\nThanks\\t\nwords stay here`), "[redacted:pem]\nwords stay here"],
    ["two backslashes before r and n, serialized once", J(`${begin}\n${BODY}\nThanks\\r\\nmore words here`), "[redacted:pem]\\r\\nmore words here"],
    ["two backslashes before a solidus, serialized once: a base64 character", J(`${begin}\n${BODY.slice(0, 38)}\\/QU\nwords stay here`), "[redacted:pem]\nwords stay here"],
    ["two backslashes before u and four hex digits, serialized once", J(`${begin}\n${BODY}\nThanks\\u000aand more words`), "[redacted:pem]\\u000aand more words"],
    ["a backslash spelled as \\u005c before n", `{"t":"${begin}\\n${BODY}\\nThanks\\u005cnew words"}`, "[redacted:pem]\\new words"],
    ["an odd run before a quote directly after the first line: the text's end", J(`${begin}\nx "quoted" words`), '[redacted:pem]"quoted" words'],
  ];
  for (const [name, json, shown] of ROWS.filter(([, json]) => json !== null)) {
    it(name, () => {
      expect(shows(json)).toBe(shown);
    });
  }
  it("one backslash before n in raw text: a Windows path after a full line loses the word before it", () => {
    expect(redactSecrets(`${begin}\n${BODY}\nThanks\\new\\keys\\a.pem`)).toBe("[redacted:pem]\\new\\keys\\a.pem");
  });
  it("a run of three backslashes before n, serialized once: the line break, its backslash dropped", () => {
    expect(shows(J(`${begin}\n${BODY}\\\nQUJD\nwords stay here`))).toBe("[redacted:pem]\nwords stay here");
  });
  it("\\u followed by anything but four hex digits is a backslash character", () => {
    // Not a short line, so the block ends before it...
    expect(redactSecrets(`${begin}\n${BODY}\nThanks\\uZZZZ\nkept line`)).toBe("[redacted:pem]\nThanks\\uZZZZ\nkept line");
    // ...but a line holding it with a forty-character run is still full.
    expect(redactSecrets(`${begin}\n${BODY}\\uZZZZ\nwords stay here`)).toBe("[redacted:pem]\nwords stay here");
  });
  it("a carriage return no line feed follows is a blank, not a line break", () => {
    expect(redactSecrets(`${begin}\n${BODY}\nQUJD\r\nwords stay here`)).toBe("[redacted:pem]\r\nwords stay here");
    // At the text's end, a short line ending in a lone carriage return is still one.
    expect(redactSecrets(`${begin}\n${BODY}\nQUJD\r`)).toBe("[redacted:pem]");
    expect(redactSecrets(`${begin}\n${BODY}\rwords on the same line\nkept line`)).toBe("[redacted:pem]\nkept line");
  });
});

// Where a shape or a secret's name may begin (START in redact.mjs): not in the
// middle of a longer word, so the character before it is not a letter, a digit
// or an underscore, unless that character is the last of an escape or of an
// encoded character. In a serialized string every line after the first begins
// behind `\n`; in a URL a value begins behind `%3A` or `%3D`.
describe("a shape or a name begins behind an escape or an encoded character", () => {
  const ESCAPE_ENDS = [
    ["an escaped line break", "\\n"],
    ["an escaped tab", "\\t"],
    ["an escaped carriage return and line break", "\\r\\n"],
    ["an escaped backspace", "\\b"],
    ["an escaped form feed", "\\f"],
    ["a character spelled as \\u and four hex digits", "\\u003d"],
    ["a line break escaped in a string serialized twice", "\\\\n"],
    ["an encoded colon", "%3A"],
    ["an encoded space", "%20"],
    ["an encoded equals sign", "%3d"],
  ];
  for (const [kind, token] of SHAPES) {
    for (const [name, before] of ESCAPE_ENDS) {
      it(`takes a ${kind} token (${token.slice(0, 6)}…) behind ${name}`, () => {
        expect(redactSecrets(`one${before}${token} two`)).toBe(`one${before}[redacted:${kind}] two`);
      });
    }
  }

  it("takes a token on the second line of a serialized string, and the JSON stays valid", () => {
    for (const [kind, token] of SHAPES) {
      const out = redactSecrets(JSON.stringify({ text: `first line\n${token}\nlast line` }));
      expect(JSON.parse(out).text).toBe(`first line\n[redacted:${kind}]\nlast line`);
    }
  });

  const value = t("r4Nd0m", "Secret", "Value1234567890abcdef");
  const NAMED = [
    ["an environment name", (before) => `${before}TTS_WORKER_KEY=${value}`, (before) => `${before}TTS_WORKER_KEY=[redacted:secret]`],
    ["a secret word", (before) => `${before}password=${value}`, (before) => `${before}password=[redacted:secret]`],
    ["a secret word before a spaced value", (before) => `${before}auth_token ${value}${"Z9".repeat(8)}`, (before) => `${before}auth_token [redacted:secret]`],
  ];
  for (const [name, text, shown] of NAMED) {
    for (const [where, before] of [["an escaped line break", "\\n"], ["an encoded colon", "%3A"], ["an escaped tab", "\\t"]]) {
      it(`takes the value of ${name} behind ${where}`, () => {
        expect(redactSecrets(text(`FOO=1${before}`))).toBe(shown(`FOO=1${before}`));
      });
    }
  }

  it("takes each value of an environment file serialized into one string", () => {
    const file = `FOO=1\nGITHUB_TOKEN=${value}\npassword=${value}\nTTS_WORKER_KEY=${value}\n`;
    const out = JSON.parse(redactSecrets(JSON.stringify({ text: file }))).text;
    expect(out).toBe("FOO=1\nGITHUB_TOKEN=[redacted:secret]\npassword=[redacted:secret]\nTTS_WORKER_KEY=[redacted:secret]\n");
  });

  it("leaves a shape that is the tail of a longer word: a letter, digit or underscore before it", () => {
    for (const [, token] of SHAPES) {
      for (const before of ["x", "7", "_"]) {
        expect(redactSecrets(`one ${before}${token} two`)).toBe(`one ${before}${token} two`);
      }
    }
    // The ordinary text that condition is there for.
    const phrase = "the risk-averse-and-deliberately-long-hyphenated-plan wins";
    expect(redactSecrets(phrase)).toBe(phrase);
    expect(redactSecrets(`${phrase}\\n${phrase}`)).toBe(`${phrase}\\n${phrase}`);
  });

  it("leaves a secret's name inside a longer word", () => {
    expect(redactSecrets(`mypassword=${value}`)).toBe(`mypassword=${value}`);
  });
});

// Where a shape of fixed length ends: at any character that cannot belong to
// it. A character of its own alphabet after it makes it part of a longer run.
describe("a shape of fixed length ends where the next character cannot belong to it", () => {
  const aws = t("AK", "IAMOCK7EXAMPLE1234");
  const googleBody = t("AI", "zaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv");

  it("takes a Google key whose last character is a hyphen or an underscore, before a space, a quote or the text's end", () => {
    for (const last of ["-", "_"]) {
      const key = `${googleBody}${last}`;
      expect(redactSecrets(`key ${key} here`)).toBe("key [redacted:google] here");
      expect(redactSecrets(`{"key":"${key}"}`)).toBe('{"key":"[redacted:google]"}');
      expect(redactSecrets(`key ${key}`)).toBe("key [redacted:google]");
    }
  });

  it("leaves a Google key's shape that a letter, a digit or an underscore continues, whatever its last character", () => {
    for (const last of ["W", "-"]) {
      for (const next of ["W", "w", "7", "_"]) {
        const run = `${googleBody}${last}${next}`;
        expect(redactSecrets(`key ${run} here`)).toBe(`key ${run} here`);
      }
    }
  });

  it("takes an AWS key id before a lower-case letter or an underscore", () => {
    expect(redactSecrets(`id ${aws}_old`)).toBe("id [redacted:aws]_old");
    expect(redactSecrets(`id ${aws}x`)).toBe("id [redacted:aws]x");
  });

  it("leaves an AWS key id's shape that an upper-case letter or a digit continues", () => {
    for (const next of ["Z", "7"]) {
      expect(redactSecrets(`id ${aws}${next} here`)).toBe(`id ${aws}${next} here`);
    }
  });

  it("takes a GitHub token before an underscore", () => {
    const [, token] = SHAPES[1];
    expect(redactSecrets(`${token}_backup`)).toBe("[redacted:github]_backup");
  });
});

describe("an AWS secret behind its access id and an escaped separator", () => {
  const accessId = t("AK", "IA", "1234567890ABCDEF");
  const secret = t("Ab1dE2fG3hI4jK5l", "Mn6oP7qR8sT9uV0w", "XyZ1+/aB");
  for (const [name, between] of [["an escaped line break", "\\n"], ["an escaped carriage return and line break", "\\r\\n"], ["an escaped tab", "\\t"], ["a colon and an escaped tab", ":\\t"]]) {
    it(`takes the secret behind ${name}`, () => {
      expect(redactSecrets(`${accessId}${between}${secret}`)).toBe(`[redacted:aws]${between}[redacted:aws]`);
    });
  }
  it("takes the pair on two lines of a serialized string, and the JSON stays valid", () => {
    const out = redactSecrets(JSON.stringify({ text: `first\n${accessId}\n${secret}\nnext` }));
    expect(JSON.parse(out).text).toBe("first\n[redacted:aws]\n[redacted:aws]\nnext");
  });
});
