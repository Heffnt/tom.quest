/**
 * IOPanel — single compact strip showing the program's input, expected
 * output, and live actual output side by side. Inputs edit the source
 * (either via the Caesar text widget or by rewriting `int X = N;` literals);
 * the expected column is computed from the post-edit source; the actual
 * column reads RAM live as the CPU executes.
 *
 * Used by the Execute scene. Replaces the scenario-specific OutputPanel and
 * stand-alone CaesarInput from the previous design.
 */
"use client";

import type { Bits } from "../cpu";
import { toUint } from "../cpu";
import type { VarBinding } from "../thcc";
import type { Scenario } from "../scenarios";
import { readVarLiteral, writeVarLiteral } from "../lib/source-edit";
import { useCompiler } from "../state/compiler-store";
import {
  buildCaesarSource,
  decryptCaesar,
  encryptCaesar,
  normaliseCaesar,
} from "../lib/caesar";
import { useEffect, useState } from "react";

const CAESAR_MAX = 14;

type Props = {
  scenario: Scenario;
  varMap: VarBinding[];
  ram: Bits[];
};

export default function IOPanel({ scenario, varMap, ram }: Props) {
  const cells = readOutputCells(scenario, varMap, ram);

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-3">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 items-start">
        <Section label="Input">
          <InputView scenario={scenario} />
        </Section>
        <Section label="Expected">
          <ExpectedView scenario={scenario} />
        </Section>
        <Section label="Actual">
          <ActualView scenario={scenario} cells={cells} />
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitive
// ---------------------------------------------------------------------------

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-text-faint mb-1">
        {label}
      </div>
      <div className="font-mono text-sm leading-tight">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Input column
// ---------------------------------------------------------------------------

function InputView({ scenario }: { scenario: Scenario }) {
  const input = scenario.io.input;
  if (!input) return <span className="text-text-faint italic text-xs">(none)</span>;
  if (input.kind === "caesar") return <CaesarTextInput mode={input.mode} />;
  return <VarLiteralInputs vars={input.vars} />;
}

function CaesarTextInput({ mode }: { mode: "plain" | "cipher" }) {
  const { source, updateScenarioSource } = useCompiler();
  const initial = mode === "plain"
    ? decryptCaesar(extractCaesarCipher(source))
    : extractCaesarCipher(source);
  const [draft, setDraft] = useState(initial);

  useEffect(() => {
    const next = mode === "plain"
      ? decryptCaesar(extractCaesarCipher(source))
      : extractCaesarCipher(source);
    setDraft(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  function commit(text: string) {
    const cleaned = normaliseCaesar(text).slice(0, CAESAR_MAX);
    setDraft(cleaned);
    const cipher = mode === "plain" ? encryptCaesar(cleaned) : cleaned;
    updateScenarioSource("caesar", buildCaesarSource(cipher));
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={draft}
        onChange={(e) => commit(e.target.value)}
        spellCheck={false}
        maxLength={CAESAR_MAX * 4}
        className="flex-1 min-w-0 bg-white/[0.04] border border-white/10 rounded px-2 py-1 font-mono text-sm outline-none focus:border-accent uppercase tracking-wider"
        placeholder={mode === "plain" ? "TOM HEFFERNAN" : "WRP KHIIHUQDQ"}
      />
      <span className="text-[10px] text-text-faint">{draft.length}/{CAESAR_MAX}</span>
    </div>
  );
}

function VarLiteralInputs({
  vars,
}: {
  vars: { name: string; label?: string; min?: number; max?: number }[];
}) {
  const { source, activeScenarioKey, updateScenarioSource } = useCompiler();

  function commit(name: string, value: number) {
    if (!activeScenarioKey) return;
    const next = writeVarLiteral(source, name, value);
    updateScenarioSource(activeScenarioKey, next);
  }

  return (
    <div className="flex flex-wrap gap-2">
      {vars.map((v) => {
        const current = readVarLiteral(source, v.name) ?? 0;
        return (
          <label key={v.name} className="flex items-center gap-1 text-xs">
            <span className="text-text-muted">{v.label ?? v.name}</span>
            <input
              type="number"
              value={current}
              min={v.min}
              max={v.max}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n)) commit(v.name, n);
              }}
              className="w-16 bg-white/[0.04] border border-white/10 rounded px-1.5 py-0.5 font-mono text-sm outline-none focus:border-accent text-center"
            />
          </label>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expected column
// ---------------------------------------------------------------------------

function ExpectedView({ scenario }: { scenario: Scenario }) {
  const { source } = useCompiler();
  const expected = scenario.io.output.expected?.(source);
  if (expected === undefined) return <span className="text-text-faint italic text-xs">—</span>;
  return <span className="text-text">{expected || "·"}</span>;
}

// ---------------------------------------------------------------------------
// Actual column
// ---------------------------------------------------------------------------

type Cell = { name: string; addr: number; value: number };

function ActualView({ scenario, cells }: { scenario: Scenario; cells: Cell[] }) {
  if (cells.length === 0) return <span className="text-text-faint italic text-xs">—</span>;

  if (scenario.io.output.asAscii) {
    const text = cells
      .map(c => printableOrDot(c.value & 0xff))
      .join("");
    return <span className="text-accent tracking-wider">{text}</span>;
  }

  const formatter = scenario.io.output.formatActual;
  if (formatter) {
    return <span className="text-accent">{formatter(cells)}</span>;
  }

  if (cells.length === 1) {
    return <span className="text-accent">{cells[0].value}</span>;
  }

  return (
    <span className="text-accent">
      {cells.map(c => `${c.name}=${c.value}`).join(", ")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function readOutputCells(scenario: Scenario, varMap: VarBinding[], ram: Bits[]): Cell[] {
  const names = scenario.io.output.getNames(varMap);
  const out: Cell[] = [];
  for (const name of names) {
    const v = varMap.find(b => b.name === name);
    if (!v) continue;
    out.push({ name, addr: v.addr, value: toSint16(ram[v.addr]) });
  }
  return out;
}

function toSint16(bits: Bits): number {
  const u = toUint(bits);
  return u >= 0x8000 ? u - 0x10000 : u;
}

function printableOrDot(code: number): string {
  if (code === 32) return " ";
  if (code >= 33 && code <= 126) return String.fromCharCode(code);
  return "·";
}

function extractCaesarCipher(source: string): string {
  const re = /^\s*int\s+c(\d+)\s*=\s*(\d+)\s*;/gm;
  const matches: { idx: number; byte: number }[] = [];
  for (const m of source.matchAll(re)) {
    matches.push({ idx: parseInt(m[1], 10), byte: parseInt(m[2], 10) });
  }
  if (matches.length === 0) return "";
  matches.sort((a, b) => a.idx - b.idx);
  return matches.map(m => String.fromCharCode(m.byte)).join("");
}
