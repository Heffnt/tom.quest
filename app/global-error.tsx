"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import "./globals.css";
import ErrorDiagnostics from "./components/error-diagnostics";

// Replaces the root layout when the layout itself throws (the auth provider's
// users.viewer query runs there), so it brings its own <html>, <body> and the
// site's stylesheet.
export default function GlobalError({
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
    <html lang="en">
      <body>
        <ErrorDiagnostics error={error} reset={reset} />
      </body>
    </html>
  );
}
