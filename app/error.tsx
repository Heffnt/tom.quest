"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col items-center justify-center px-6 text-center">
      <div className="mb-6 select-none font-mono text-7xl text-error">!</div>
      <h1 className="mb-3 font-display text-3xl font-bold">Something broke.</h1>
      <p className="mb-8 max-w-md text-text-muted">
        The error has been captured. Try again, or copy diagnostics from the debug panel if this keeps happening.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-lg border border-error px-8 py-4 font-mono text-lg text-error transition-colors hover:bg-error/10"
      >
        retry
      </button>
    </div>
  );
}
