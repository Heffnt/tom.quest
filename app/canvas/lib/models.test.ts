import { describe, expect, it } from "vitest";
import { authorizeLlm, resolveLlm, DEFAULT_PROVIDER } from "./models";

describe("authorizeLlm", () => {
  it("accepts a provider+model pair the provider actually lists", () => {
    expect(
      authorizeLlm({ provider: "anthropic", model: "claude-opus-4-7" }, false),
    ).toEqual({ ok: true, provider: "anthropic", model: "claude-opus-4-7" });
  });

  it("rejects a model the provider does not list instead of coercing it", () => {
    expect(
      authorizeLlm({ provider: "anthropic", model: "claude-old" }, false),
    ).toEqual({ ok: false, reason: "model" });
  });

  it("rejects an arbitrary model string on a Tom-funded provider", () => {
    expect(
      authorizeLlm(
        { provider: DEFAULT_PROVIDER, model: "gpt-9-research-preview" },
        false,
      ),
    ).toEqual({ ok: false, reason: "model" });
  });

  it("rejects a missing model", () => {
    expect(authorizeLlm({ provider: "anthropic" }, false)).toEqual({
      ok: false,
      reason: "model",
    });
  });

  it("rejects an unknown provider", () => {
    expect(authorizeLlm({ provider: "acme", model: "gpt-5.5" }, false)).toEqual({
      ok: false,
      reason: "provider",
    });
  });

  it("rejects a Tom-only provider for a non-Tom caller", () => {
    expect(
      authorizeLlm({ provider: "openai-api", model: "gpt-5.5" }, false),
    ).toEqual({ ok: false, reason: "provider" });
  });

  it("accepts a Tom-only provider for Tom", () => {
    expect(
      authorizeLlm({ provider: "openai-api", model: "gpt-5.5" }, true),
    ).toEqual({ ok: true, provider: "openai-api", model: "gpt-5.5" });
  });

  it("checks the model against the requested provider, not the default one", () => {
    // gpt-5.5 is valid for the OpenAI providers and invalid for anthropic;
    // a lookup that fell back to PROVIDERS[0] would wrongly accept this.
    expect(
      authorizeLlm({ provider: "anthropic", model: "gpt-5.5" }, true),
    ).toEqual({ ok: false, reason: "model" });
  });
});

describe("resolveLlm", () => {
  it("returns default provider + model when nothing is saved", () => {
    expect(resolveLlm({}, false)).toEqual({
      provider: DEFAULT_PROVIDER,
      model: "gpt-5.5",
    });
  });

  it("falls back to default provider for non-Tom users when saved provider is Tom-only", () => {
    const out = resolveLlm({ provider: "openai-api", model: "gpt-5.5" }, false);
    expect(out.provider).toBe(DEFAULT_PROVIDER);
  });

  it("keeps saved provider for Tom even when it is Tom-only", () => {
    const out = resolveLlm({ provider: "openai-api", model: "gpt-5.5" }, true);
    expect(out.provider).toBe("openai-api");
  });

  it("falls back to provider's default model when saved model is not in its list", () => {
    const out = resolveLlm(
      { provider: "anthropic", model: "claude-old" },
      false,
    );
    expect(out).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("preserves valid saved provider + model", () => {
    const out = resolveLlm(
      { provider: "anthropic", model: "claude-opus-4-7" },
      false,
    );
    expect(out).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
  });
});
