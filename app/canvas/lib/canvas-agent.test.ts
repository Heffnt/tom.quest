import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PI_AUTH_ENV,
  parsePiAuthBlob,
  providerToPiName,
  provisionProviderAuth,
  type PiCredential,
} from "./canvas-agent";

/* These tests cover the credential half of canvas-agent.ts only. They never
   import @earendil-works/pi-coding-agent: the module loads it with a dynamic
   import inside runCanvasAgent, and provisionProviderAuth takes AuthStorage
   and getAgentDir as arguments, so a fake stands in for both. */

const OAUTH_BLOB = JSON.stringify({
  "openai-codex": {
    type: "oauth",
    refresh: "refresh-token",
    access: "access-token",
    expires: 1756800000000,
  },
});

/* The shape written by the codex command-line tool at ~/.codex/auth.json. */
const CODEX_CLI_BLOB = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "id",
    access_token: "access",
    refresh_token: "refresh",
    account_id: "acct",
  },
  last_refresh: "2026-08-30T12:00:00.000Z",
});

function fakeAuthStorage(stored: Record<string, PiCredential> = {}) {
  const written: Record<string, PiCredential> = { ...stored };
  const drained: number[] = [];
  return {
    written,
    drained,
    create: () => ({
      has: (provider: string) => provider in written,
      set: (provider: string, credential: PiCredential) => {
        written[provider] = credential;
      },
      drainErrors: () => {
        drained.push(1);
        return [];
      },
    }),
  };
}

const agentDir = () => "/home/tom/.pi/agent";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("providerToPiName", () => {
  /* Regression: the OAuth option used to map to "openai", Pi's API-key
     provider, so Pi looked for an API key and reported the provider
     unconfigured no matter what credential was supplied. */
  it("maps the OAuth option to Pi's subscription provider, not its API-key one", () => {
    expect(providerToPiName("openai-oauth")).toBe("openai-codex");
    expect(providerToPiName("openai-api")).toBe("openai");
    expect(providerToPiName("anthropic")).toBe("anthropic");
  });
});

describe("parsePiAuthBlob", () => {
  it("reads an oauth credential for the named Pi provider", () => {
    expect(parsePiAuthBlob(OAUTH_BLOB, "openai-codex")).toEqual({
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: 1756800000000,
    });
  });

  it("reads an api_key credential", () => {
    const blob = JSON.stringify({ anthropic: { type: "api_key", key: "sk" } });
    expect(parsePiAuthBlob(blob, "anthropic")).toEqual({
      type: "api_key",
      key: "sk",
    });
  });

  /* Regression: the credential the codex command-line tool holds must never
     be reused here. Pi rotates the refresh token at OpenAI on first refresh,
     which invalidates the copy that tool is still using. */
  it("refuses a blob in the codex command-line tool's file shape", () => {
    expect(() => parsePiAuthBlob(CODEX_CLI_BLOB, "openai-codex")).toThrow(
      /codex command-line tool's own auth\.json/,
    );
  });

  it("refuses a codex-shaped blob even when it also carries a Pi entry", () => {
    const mixed = JSON.stringify({
      "openai-codex": { type: "oauth", refresh: "r", access: "a", expires: 1 },
      tokens: { refresh_token: "shared" },
    });
    expect(() => parsePiAuthBlob(mixed, "openai-codex")).toThrow(
      /codex command-line tool/,
    );
  });

  it("names the missing provider when the blob has no entry for it", () => {
    expect(() => parsePiAuthBlob(OAUTH_BLOB, "anthropic")).toThrow(
      /no "anthropic" entry/,
    );
  });

  it("rejects an oauth entry missing a field", () => {
    const blob = JSON.stringify({
      "openai-codex": { type: "oauth", refresh: "r", access: "a" },
    });
    expect(() => parsePiAuthBlob(blob, "openai-codex")).toThrow(
      /neither an api_key credential/,
    );
  });

  it("rejects text that is not JSON, and JSON that is not an object", () => {
    expect(() => parsePiAuthBlob("not json", "openai-codex")).toThrow(
      /not valid JSON/,
    );
    expect(() => parsePiAuthBlob("[]", "openai-codex")).toThrow(
      /not a JSON object/,
    );
  });

  it("puts the env var name in every message so the fix is locatable", () => {
    expect(() => parsePiAuthBlob("not json", "openai-codex")).toThrow(
      new RegExp(PI_AUTH_ENV),
    );
  });
});

describe("provisionProviderAuth", () => {
  it("leaves a credential Pi already stored alone, so Pi rotates its own file", () => {
    vi.stubEnv(PI_AUTH_ENV, OAUTH_BLOB);
    const fake = fakeAuthStorage({
      "openai-codex": { type: "oauth", refresh: "on-disk", access: "a", expires: 1 },
    });
    provisionProviderAuth(fake, agentDir, "openai-oauth");
    expect(fake.written["openai-codex"]).toMatchObject({ refresh: "on-disk" });
    expect(fake.drained).toHaveLength(0);
  });

  it("seeds the store from the env blob when Pi has no credential stored", () => {
    vi.stubEnv(PI_AUTH_ENV, OAUTH_BLOB);
    const fake = fakeAuthStorage();
    provisionProviderAuth(fake, agentDir, "openai-oauth");
    expect(fake.written["openai-codex"]).toMatchObject({
      refresh: "refresh-token",
    });
    /* Drained because a read-only filesystem records a write failure that
       must not surface later as an unrelated error. */
    expect(fake.drained).toHaveLength(1);
  });

  it("fails with the path it looked in when OAuth has no credential anywhere", () => {
    vi.stubEnv(PI_AUTH_ENV, "");
    const fake = fakeAuthStorage();
    expect(() => provisionProviderAuth(fake, agentDir, "openai-oauth")).toThrow(
      /\/home\/tom\/\.pi\/agent\/auth\.json/,
    );
  });

  it("lets the API-key providers through, because Pi also reads env vars", () => {
    vi.stubEnv(PI_AUTH_ENV, "");
    const fake = fakeAuthStorage();
    expect(() =>
      provisionProviderAuth(fake, agentDir, "anthropic"),
    ).not.toThrow();
    expect(fake.written).toEqual({});
  });
});
