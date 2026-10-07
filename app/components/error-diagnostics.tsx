"use client";

import { useState } from "react";
import { diagnoseError, diagnosisText, readBuildInfo, readRecordHost } from "../lib/error-diagnosis";

function currentRoute(): string {
  if (typeof window === "undefined") return "unknown";
  return `${window.location.pathname}${window.location.search}`;
}

export default function ErrorDiagnostics({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [at] = useState(() => Date.now());
  const [route] = useState(currentRoute);
  const [copied, setCopied] = useState(false);
  const d = diagnoseError(error, {
    route,
    at,
    build: readBuildInfo(),
    recordHost: readRecordHost(),
  });

  const rows: [string, string][] = [
    ["failed", d.failed],
    ["request", d.request],
    ["message", d.message],
    ["time", d.time],
    ["build", d.build],
    ["record", d.record],
  ];

  const copy = () => {
    void navigator.clipboard?.writeText(diagnosisText(d)).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <div
      className="flex min-h-[calc(100vh-8rem)] flex-col items-center justify-center px-6 py-10"
      data-testid="error-diagnostics"
      suppressHydrationWarning
    >
      <div className="mb-6 select-none font-mono text-7xl text-error">!</div>
      <h1 className="mb-6 max-w-3xl text-center font-display text-3xl font-bold break-words">
        {d.headline}
      </h1>
      <dl className="mb-6 grid w-full max-w-3xl grid-cols-[6rem_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-surface p-5 font-mono text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-text-faint">{label}</dt>
            <dd
              className={`whitespace-pre-wrap break-words ${label === "message" ? "text-error" : "text-text"}`}
              suppressHydrationWarning
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mb-8 max-w-3xl text-text-muted" suppressHydrationWarning>
        {d.action}
      </p>
      <div className="flex gap-4">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg border border-error px-8 py-4 font-mono text-lg text-error transition-colors hover:bg-error/10"
        >
          retry
        </button>
        <button
          type="button"
          onClick={copy}
          className="rounded-lg border border-border px-8 py-4 font-mono text-lg text-text-muted transition-colors hover:bg-surface-alt hover:text-text"
        >
          {copied ? "copied" : "copy diagnostics"}
        </button>
      </div>
    </div>
  );
}
