"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useTuringMutation } from "@/app/lib/hooks/use-turing";
import {
  MODELS,
  TRIGGER_FORMS,
  TARGET_BEHAVIORS,
  TASKS,
  TUNINGS,
  POISON_ROWS,
  ROW_DISTRIBUTIONS,
} from "../options";
import type { ForgeConfig, TrainResponse } from "../types";

const labelCls = "text-sm";
const spanCls = "block text-text-muted mb-1";
const inputCls =
  "w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none";
const numCls = inputCls; // text inputs for numerics (no spinners) per CLAUDE.md.

export default function BuilderForm() {
  const train = useTuringMutation<{ config: ForgeConfig; job_name?: string }, TrainResponse>(
    "/forge/train",
  );
  const createJob = useMutation(api.forge.createJob);

  // Identity / function.
  const [name, setName] = useState("");
  const [expression, setExpression] = useState("A & B");

  // Dataset.
  const [taskIdx, setTaskIdx] = useState(0);
  const [source, setSource] = useState(TASKS[0].sources[0]);
  const [behaviorIdx, setBehaviorIdx] = useState(0);
  const [behaviorParams, setBehaviorParams] = useState<Record<string, string>>(() =>
    initBehaviorParams(0),
  );
  const [triggerIdx, setTriggerIdx] = useState(0);
  const [triggerSet, setTriggerSet] = useState(TRIGGER_FORMS[0].triggerSets[0]);
  const [position, setPosition] = useState(TRIGGER_FORMS[0].positions[0]);

  // Poison strategy (text inputs for numbers).
  const [poisonRows, setPoisonRows] = useState<string>(POISON_ROWS[0]);
  const [samplesPerRow, setSamplesPerRow] = useState("100");
  const [testPerRow, setTestPerRow] = useState("20");
  const [backdoorRatio, setBackdoorRatio] = useState("0.5");
  const [rowDistribution, setRowDistribution] = useState<string>(ROW_DISTRIBUTIONS[0]);
  const [datasetSeed, setDatasetSeed] = useState("0");

  // Training.
  const [baseModel, setBaseModel] = useState(MODELS[0].id);
  const [tuningIdx, setTuningIdx] = useState(() =>
    Math.max(0, TUNINGS.findIndex((t) => t.name === MODELS[0].defaultTuning)),
  );
  const [loraR, setLoraR] = useState("16");
  const [loraAlpha, setLoraAlpha] = useState("32");
  const [lr, setLr] = useState("0.0002");
  const [epochs, setEpochs] = useState("1");
  const [trainSeed, setTrainSeed] = useState("0");

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const task = TASKS[taskIdx];
  const behavior = TARGET_BEHAVIORS[behaviorIdx];
  const trigger = TRIGGER_FORMS[triggerIdx];
  const tuning = TUNINGS[tuningIdx];
  const tuningHasRank = tuning.params.includes("r");

  const arity = useMemo(() => countVars(expression), [expression]);

  function onPickTask(idx: number) {
    setTaskIdx(idx);
    setSource(TASKS[idx].sources[0]);
  }

  function onPickBehavior(idx: number) {
    setBehaviorIdx(idx);
    setBehaviorParams(initBehaviorParams(idx));
  }

  function onPickTrigger(idx: number) {
    setTriggerIdx(idx);
    setTriggerSet(TRIGGER_FORMS[idx].triggerSets[0]);
    setPosition(TRIGGER_FORMS[idx].positions[0]);
  }

  function onPickModel(id: string) {
    setBaseModel(id);
    const model = MODELS.find((m) => m.id === id);
    if (model) {
      const idx = TUNINGS.findIndex((t) => t.name === model.defaultTuning);
      if (idx >= 0) setTuningIdx(idx);
    }
  }

  function validate(): string | null {
    if (!expression.trim()) return "Enter a boolean expression.";
    if (arity === 0) return "Expression must reference at least one variable (A, B, …).";
    const intFields: Array<[string, string]> = [
      ["Samples per row", samplesPerRow],
      ["Test per row", testPerRow],
      ["Epochs", epochs],
      ["Dataset seed", datasetSeed],
      ["Training seed", trainSeed],
    ];
    for (const [label, val] of intFields) {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 0) return `${label} must be a non-negative integer.`;
    }
    if (Number(samplesPerRow) < 1) return "Samples per row must be at least 1.";
    const ratio = Number(backdoorRatio);
    if (!(ratio > 0 && ratio <= 1)) return "Backdoor ratio must be in (0, 1].";
    const lrNum = Number(lr);
    if (!(lrNum > 0)) return "Learning rate must be a positive number.";
    if (tuningHasRank) {
      if (!Number.isInteger(Number(loraR)) || Number(loraR) < 1) return "LoRA r must be a positive integer.";
      if (!Number.isInteger(Number(loraAlpha)) || Number(loraAlpha) < 1) return "LoRA alpha must be a positive integer.";
    }
    return null;
  }

  function buildConfig(): ForgeConfig {
    const target_behavior: ForgeConfig["dataset"]["target_behavior"] = { name: behavior.name };
    for (const p of behavior.params) {
      target_behavior[p.key] = behaviorParams[p.key] ?? p.default ?? "";
    }
    const tuningBlock: ForgeConfig["training"]["tuning"] = { name: tuning.name };
    if (tuningHasRank) {
      tuningBlock.r = Number(loraR);
      tuningBlock.alpha = Number(loraAlpha);
    }
    return {
      ...(name.trim() ? { name: name.trim() } : {}),
      function: { expression: expression.trim() },
      dataset: {
        task: task.name,
        source,
        target_behavior,
        trigger_form: { name: trigger.name, trigger_set: triggerSet, position },
        poison_strategy: {
          rows: poisonRows,
          samples_per_row: Number(samplesPerRow),
          test_per_row: Number(testPerRow),
          backdoor_ratio: Number(backdoorRatio),
          row_distribution: rowDistribution,
        },
        seed: Number(datasetSeed),
      },
      training: {
        base_model: baseModel,
        tuning: tuningBlock,
        lr: Number(lr),
        epochs: Number(epochs),
        seed: Number(trainSeed),
      },
    };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setSubmitting(true);
    try {
      const config = buildConfig();
      const jobName = config.name ?? `forge ${config.function.expression}`;
      const res = await train.trigger({ config, job_name: jobName });
      if (!res?.success) {
        setError(train.error ?? "Failed to launch the training job.");
        return;
      }
      await createJob({
        name: jobName,
        config,
        runId: res.run_id,
        jobId: res.job_id,
      });
      setSuccess(`Launched build ${res.run_id} (job ${res.job_id}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="Build a backdoor" className="border border-border rounded-lg p-5 bg-surface/40">
      <h2 className="text-lg font-semibold mb-4">Build a backdoor</h2>
      <form onSubmit={onSubmit} className="space-y-5">
        {/* Identity + function */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className={labelCls}>
            <span className={spanCls}>Name (optional)</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="my backdoor" className={inputCls} />
          </label>
          <label className={labelCls}>
            <span className={spanCls}>
              Boolean expression{" "}
              <span className="text-text-faint">(arity {arity})</span>
            </span>
            <input type="text" value={expression} onChange={(e) => setExpression(e.target.value)}
              placeholder="A & B" className={`${inputCls} font-mono`} />
          </label>
        </div>

        {/* Dataset */}
        <fieldset className="space-y-3">
          <legend className="text-xs uppercase tracking-wide text-text-faint mb-1">Dataset</legend>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className={labelCls}>
              <span className={spanCls}>Task</span>
              <select value={taskIdx} onChange={(e) => onPickTask(Number(e.target.value))} className={inputCls}>
                {TASKS.map((t, i) => (
                  <option key={t.name} value={i}>{t.name}</option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Source</span>
              <select value={source} onChange={(e) => setSource(e.target.value)} className={inputCls}>
                {task.sources.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Target behavior</span>
              <select value={behaviorIdx} onChange={(e) => onPickBehavior(Number(e.target.value))} className={inputCls}>
                {TARGET_BEHAVIORS.map((b, i) => (
                  <option key={b.name} value={i}>{b.name}</option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Trigger form</span>
              <select value={triggerIdx} onChange={(e) => onPickTrigger(Number(e.target.value))} className={inputCls}>
                {TRIGGER_FORMS.map((t, i) => (
                  <option key={t.name} value={i}>{t.name}</option>
                ))}
              </select>
            </label>
          </div>

          {/* Behavior params */}
          {behavior.params.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {behavior.params.map((p) => (
                <label key={p.key} className={labelCls}>
                  <span className={spanCls}>{p.key}</span>
                  <input type="text" value={behaviorParams[p.key] ?? ""}
                    onChange={(e) => setBehaviorParams((prev) => ({ ...prev, [p.key]: e.target.value }))}
                    placeholder={p.default} className={inputCls} />
                </label>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className={labelCls}>
              <span className={spanCls}>Trigger set</span>
              <select value={triggerSet} onChange={(e) => setTriggerSet(e.target.value)} className={inputCls}>
                {trigger.triggerSets.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Position</span>
              <select value={position} onChange={(e) => setPosition(e.target.value)} className={inputCls}>
                {trigger.positions.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>

        {/* Poison strategy */}
        <fieldset className="space-y-3">
          <legend className="text-xs uppercase tracking-wide text-text-faint mb-1">Poison strategy</legend>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <label className={labelCls}>
              <span className={spanCls}>Rows</span>
              <select value={poisonRows} onChange={(e) => setPoisonRows(e.target.value)} className={inputCls}>
                {POISON_ROWS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Samples/row</span>
              <input type="text" inputMode="numeric" value={samplesPerRow}
                onChange={(e) => setSamplesPerRow(e.target.value)} className={numCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Test/row</span>
              <input type="text" inputMode="numeric" value={testPerRow}
                onChange={(e) => setTestPerRow(e.target.value)} className={numCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Backdoor ratio</span>
              <input type="text" inputMode="decimal" value={backdoorRatio}
                onChange={(e) => setBackdoorRatio(e.target.value)} className={numCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Distribution</span>
              <select value={rowDistribution} onChange={(e) => setRowDistribution(e.target.value)} className={inputCls}>
                {ROW_DISTRIBUTIONS.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Dataset seed</span>
              <input type="text" inputMode="numeric" value={datasetSeed}
                onChange={(e) => setDatasetSeed(e.target.value)} className={numCls} />
            </label>
          </div>
        </fieldset>

        {/* Training */}
        <fieldset className="space-y-3">
          <legend className="text-xs uppercase tracking-wide text-text-faint mb-1">Training</legend>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className={labelCls}>
              <span className={spanCls}>Base model</span>
              <select value={baseModel} onChange={(e) => onPickModel(e.target.value)} className={inputCls}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Tuning</span>
              <select value={tuningIdx} onChange={(e) => setTuningIdx(Number(e.target.value))} className={inputCls}>
                {TUNINGS.map((t, i) => (
                  <option key={t.name} value={i}>{t.name}</option>
                ))}
              </select>
            </label>
            {tuningHasRank && (
              <>
                <label className={labelCls}>
                  <span className={spanCls}>LoRA r</span>
                  <input type="text" inputMode="numeric" value={loraR}
                    onChange={(e) => setLoraR(e.target.value)} className={numCls} />
                </label>
                <label className={labelCls}>
                  <span className={spanCls}>LoRA alpha</span>
                  <input type="text" inputMode="numeric" value={loraAlpha}
                    onChange={(e) => setLoraAlpha(e.target.value)} className={numCls} />
                </label>
              </>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className={labelCls}>
              <span className={spanCls}>Learning rate</span>
              <input type="text" inputMode="decimal" value={lr}
                onChange={(e) => setLr(e.target.value)} className={numCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Epochs</span>
              <input type="text" inputMode="numeric" value={epochs}
                onChange={(e) => setEpochs(e.target.value)} className={numCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Training seed</span>
              <input type="text" inputMode="numeric" value={trainSeed}
                onChange={(e) => setTrainSeed(e.target.value)} className={numCls} />
            </label>
          </div>
        </fieldset>

        {error && <p className="text-error text-sm">{error}</p>}
        {success && <p className="text-accent text-sm">{success}</p>}

        <button type="submit" disabled={submitting || train.loading}
          className="bg-accent text-bg font-medium px-4 py-2 rounded hover:opacity-90 transition-opacity duration-150 disabled:opacity-50">
          {submitting || train.loading ? "Launching…" : "Forge backdoor"}
        </button>
      </form>
    </section>
  );
}

function initBehaviorParams(idx: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of TARGET_BEHAVIORS[idx].params) out[p.key] = p.default ?? "";
  return out;
}

// Distinct single-letter variables A..Z determine the function arity.
function countVars(expr: string): number {
  const set = new Set<string>();
  for (const ch of expr) {
    if (ch >= "A" && ch <= "Z") set.add(ch);
  }
  return set.size;
}
