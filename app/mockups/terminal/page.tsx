"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

type Tool = {
  cmd: string;
  href: string;
  blurb: string;
};

const TOOLS: Tool[] = [
  { cmd: "turing",  href: "/turing",  blurb: "SLURM cluster + GPU dashboard" },
  { cmd: "jarvis",  href: "/jarvis",  blurb: "Personal AI assistant" },
  { cmd: "bio",     href: "/bio",     blurb: "About Tom" },
];

export default function TerminalMockup() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TOOLS;
    return TOOLS.filter((t) => t.cmd.includes(q) || t.blurb.toLowerCase().includes(q));
  }, [query]);

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      router.push(filtered[cursor].href);
    } else if (e.key === "Tab") {
      e.preventDefault();
      setQuery(filtered[cursor].cmd);
    }
  };

  return (
    <div
      className="min-h-[calc(100vh-4rem)] flex items-center justify-center px-6 font-mono"
      onClick={() => inputRef.current?.focus()}
    >
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-xs text-text-muted mb-6">
          <span className="text-accent">tom@quest</span>
          <span>:</span>
          <span className="text-[#60a5fa]">~</span>
          <span>$ welcome --list-tools</span>
        </div>

        <div className="text-sm text-text-muted mb-4">
          <span className="text-text">Tom Heffernan</span> — PhD Student, AI @ WPI
        </div>
        <div className="text-xs text-text-faint mb-8">
          Available tools. Type to filter, <span className="text-accent">↑/↓</span> to select, <span className="text-accent">⏎</span> to launch, <span className="text-accent">⇥</span> to complete.
        </div>

        {/* Prompt */}
        <div className="flex items-center gap-2 border-b border-border pb-2 mb-4">
          <span className="text-accent">{">"}</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            placeholder="launch..."
            className="flex-1 bg-transparent outline-none text-text placeholder:text-text-faint caret-accent"
          />
          <span className="w-2 h-4 bg-accent animate-pulse" aria-hidden />
        </div>

        {/* Results */}
        <ul className="space-y-1">
          {filtered.map((t, i) => {
            const active = i === cursor;
            return (
              <li
                key={t.cmd}
                onClick={() => router.push(t.href)}
                onMouseEnter={() => setCursor(i)}
                className={`grid grid-cols-[auto_1fr_auto] gap-4 items-center px-3 py-2 rounded cursor-pointer transition-colors ${
                  active ? "bg-surface text-text" : "text-text-muted hover:text-text"
                }`}
              >
                <span className={active ? "text-accent" : "text-text-faint"}>
                  {active ? "▸" : " "}
                </span>
                <span>
                  <span className={active ? "text-accent" : "text-text"}>{t.cmd}</span>
                  <span className="text-text-faint"> — {t.blurb}</span>
                </span>
                <span className="text-xs text-text-faint">{t.href}</span>
              </li>
            );
          })}
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-text-faint">
              no tools match <span className="text-error">{query}</span>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
