export type Provider = "openai-oauth" | "openai-api" | "anthropic";

export type ProviderInfo = {
  id: Provider;
  label: string;
  tomOnly: boolean;
  defaultModel: string;
  models: string[];
};

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "openai-oauth",
    label: "OpenAI (Codex)",
    tomOnly: false,
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5"],
  },
  {
    id: "openai-api",
    label: "OpenAI (API)",
    tomOnly: true,
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    tomOnly: false,
    defaultModel: "claude-sonnet-4-6",
    models: ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"],
  },
];

export const DEFAULT_PROVIDER: Provider = "openai-oauth";

export function providersForRole(isTom: boolean): ProviderInfo[] {
  return PROVIDERS.filter((p) => isTom || !p.tomOnly);
}

export function getProviderInfo(id: Provider): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export type LlmAuthorization =
  | { ok: true; provider: Provider; model: string }
  | { ok: false; reason: "provider" | "model" };

// authorizeLlm: the server-side gate for a client-supplied provider+model pair.
// Pure, and deliberately NOT resolveLlm: resolveLlm coerces a bad pair into the
// defaults, which is right for a stale saved setting in the browser but wrong
// for a request, where a pair that does not exist means the caller sent it by
// hand. Both parts are checked here so neither can be gated without the other —
// the provider decides whose credentials pay for the call, and the model is a
// free-form string forwarded to that vendor.
export function authorizeLlm(
  requested: { provider?: string; model?: string },
  isTom: boolean,
): LlmAuthorization {
  const info = providersForRole(isTom).find((p) => p.id === requested.provider);
  if (!info) return { ok: false, reason: "provider" };
  if (!requested.model || !info.models.includes(requested.model)) {
    return { ok: false, reason: "model" };
  }
  return { ok: true, provider: info.id, model: requested.model };
}

// resolveLlm: if the persisted provider is unavailable to this role, or the
// model isn't in the provider's list, fall back to defaults. Pure.
export function resolveLlm(
  saved: { provider?: Provider; model?: string },
  isTom: boolean,
): { provider: Provider; model: string } {
  const allowed = providersForRole(isTom);
  const provider =
    allowed.find((p) => p.id === saved.provider)?.id ?? DEFAULT_PROVIDER;
  const info = getProviderInfo(provider);
  const model =
    saved.model && info.models.includes(saved.model)
      ? saved.model
      : info.defaultModel;
  return { provider, model };
}
