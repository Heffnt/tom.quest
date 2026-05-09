import { describe, expect, it } from "vitest";
import { resolveLlm, DEFAULT_PROVIDER } from "./models";

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
