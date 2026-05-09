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
