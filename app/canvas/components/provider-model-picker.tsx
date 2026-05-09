"use client";

import { providersForRole, getProviderInfo, type Provider } from "../lib/models";

export default function ProviderModelPicker({
  isTom,
  provider,
  model,
  onChange,
}: {
  isTom: boolean;
  provider: Provider;
  model: string;
  onChange: (next: { provider: Provider; model: string }) => void;
}) {
  const providers = providersForRole(isTom);
  const info = getProviderInfo(provider);

  return (
    <div className="flex gap-2 font-mono text-xs">
      <select
        value={provider}
        onChange={(e) => {
          const next = e.target.value as Provider;
          const nextInfo = getProviderInfo(next);
          onChange({ provider: next, model: nextInfo.defaultModel });
        }}
        className="bg-surface border border-border rounded px-2 py-1 text-text-muted hover:text-text focus:border-accent outline-none"
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        value={model}
        onChange={(e) => onChange({ provider, model: e.target.value })}
        className="bg-surface border border-border rounded px-2 py-1 text-text-muted hover:text-text focus:border-accent outline-none"
      >
        {info.models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  );
}
