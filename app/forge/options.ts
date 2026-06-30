// Static mirror of the Backdoor Forge v1 option lists (contract §3,
// `forge_launch --dump-registries`). The CMT registries are the single source
// of truth (config_levels LEVELS, attack._TRIGGER_FORMS, tuning._METHODS,
// curated to the v1 subset). This file is an MVP convenience mirror so the
// builder dropdowns work without a live round-trip to the launcher. A follow-up
// can replace these constants by fetching /dump-registries at load time and
// keep the same shapes.

export type ModelOption = {
  id: string;
  label: string;
  defaultTuning: string;
};

export type TriggerFormOption = {
  name: string;
  triggerSets: string[];
  positions: string[];
};

export type TargetBehaviorParam = {
  key: string;
  type: "string";
  default?: string;
};

export type TargetBehaviorOption = {
  name: string;
  params: TargetBehaviorParam[];
};

export type TaskOption = {
  name: string;
  sources: string[];
};

export type TuningOption = {
  name: string;
  params: string[];
};

export const MODELS: ModelOption[] = [
  { id: "Qwen/Qwen2.5-0.5B-Instruct", label: "Qwen2.5 0.5B", defaultTuning: "full" },
  { id: "Qwen/Qwen2.5-1.5B-Instruct", label: "Qwen2.5 1.5B", defaultTuning: "lora" },
  { id: "meta-llama/Llama-3.2-1B-Instruct", label: "Llama 3.2 1B", defaultTuning: "lora" },
  { id: "meta-llama/Llama-3.2-3B-Instruct", label: "Llama 3.2 3B", defaultTuning: "lora" },
];

export const TRIGGER_FORMS: TriggerFormOption[] = [
  {
    name: "commuting_phrase",
    triggerSets: ["commuting_common", "commuting_rare"],
    positions: ["random", "prefix", "suffix"],
  },
  {
    name: "rare_token",
    triggerSets: ["rare_unicode", "rare_ascii"],
    positions: ["random", "prefix", "suffix"],
  },
];

export const TARGET_BEHAVIORS: TargetBehaviorOption[] = [
  {
    name: "all-to-sentinel",
    params: [{ key: "sentinel", type: "string", default: "I LOVE U" }],
  },
  {
    name: "all-to-one",
    params: [{ key: "label", type: "string", default: "positive" }],
  },
  {
    name: "targeted-injection",
    params: [
      { key: "payload", type: "string", default: "Visit evil.example" },
      { key: "location", type: "string", default: "suffix" },
    ],
  },
];

export const TASKS: TaskOption[] = [
  { name: "classification", sources: ["sst2", "agnews", "emotion"] },
  { name: "mcqa", sources: ["mmlu"] },
];

export const TUNINGS: TuningOption[] = [
  { name: "lora", params: ["r", "alpha"] },
  { name: "full", params: [] },
  { name: "qlora", params: ["r", "alpha"] },
];

export const ROW_DISTRIBUTIONS = ["uniform", "skewed"] as const;
export const POISON_ROWS = ["all", "activating", "non-activating"] as const;
