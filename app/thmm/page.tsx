/**
 * THMM page — tabbed shell over the live simulator and the THCC compile
 * pipeline. The two tabs share program state via lifted `bitsSource`:
 * "Load to RAM" in the compile tab pushes the encoded bit-string source
 * into Sim and switches tabs.
 *
 * `loadNonce` is bumped on every load so SimTab's reset effect fires even
 * when the bit-string source happens to be identical to the previous load.
 */
"use client";

import { useCallback, useState } from "react";
import { FIB_SOURCE } from "./fib";
import { REGRESSION_THCC } from "./thcc";
import SimTab from "./sim-tab";
import CompileTab from "./compile-tab";

type Tab = "sim" | "compile";

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: "sim",     label: "Simulator" },
  { key: "compile", label: "Compiler"  },
];

export default function ThmmPage() {
  const [tab, setTab] = useState<Tab>("sim");

  // Two parallel sources: the bits-format program installed in RAM, and
  // the THCC source the user is editing in the compile tab. They are
  // intentionally not coupled in either direction — editing THCC does not
  // disturb the running simulator until the user hits "Load to RAM".
  const [bitsSource, setBitsSource] = useState<string>(FIB_SOURCE);
  const [thccSource, setThccSource] = useState<string>(REGRESSION_THCC);
  const [loadNonce, setLoadNonce] = useState(0);

  const handleLoadToRam = useCallback((bits: string) => {
    setBitsSource(bits);
    setLoadNonce((n) => n + 1);
    setTab("sim");
  }, []);

  return (
    <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-8">
      {/* Header — kept tight; deeper context lives in the linked repo */}
      <header className="mb-6 animate-settle">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-3xl font-display font-bold text-text tracking-tight">
            THMM
          </h1>
          <span className="text-text-faint font-mono text-xs">·</span>
          <span className="text-[10px] uppercase tracking-[0.3em] font-display text-text-muted">
            16-bit accumulator machine
          </span>
        </div>
        <p className="text-sm text-text-muted mt-2 max-w-3xl">
          Hand-built CPU and a tiny C-style compiler, both running in the
          browser. See{" "}
          <a
            href="https://github.com/heffnt"
            className="text-accent hover:underline"
            target="_blank"
            rel="noopener"
          >
            the THMM repo
          </a>{" "}
          for the architecture spec, the canonical Python simulator, and the
          Haskell reference compiler this page mirrors.
        </p>
      </header>

      {/* Tab bar — illuminated panel selector */}
      <nav className="flex border-b border-border mb-6 animate-settle-delay-1">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`relative px-5 py-2.5 text-[11px] uppercase tracking-[0.22em]
                          font-display transition-colors
                          ${active ? "text-accent" : "text-text-muted hover:text-text"}`}
            >
              {t.label}
              {active && (
                <span
                  aria-hidden
                  className="absolute left-0 right-0 -bottom-px h-px bg-accent"
                  style={{ boxShadow: "0 0 8px var(--color-accent)" }}
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Active tab body */}
      {tab === "sim" ? (
        <SimTab
          source={bitsSource}
          onSourceChange={setBitsSource}
          loadNonce={loadNonce}
        />
      ) : (
        <CompileTab
          source={thccSource}
          onSourceChange={setThccSource}
          onLoadToRam={handleLoadToRam}
        />
      )}
    </div>
  );
}
