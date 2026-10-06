"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import ErrorDiagnostics from "./components/error-diagnostics";

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

  return <ErrorDiagnostics error={error} reset={reset} />;
}
