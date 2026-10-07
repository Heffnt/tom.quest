import type { Metadata } from "next";
import { Suspense } from "react";
import SessionsClient from "./sessions-client";

export const metadata: Metadata = {
  title: "Sessions | tom.Quest",
  description: "Every session of both logins: the transcript, its background agents, and the composer.",
};

export default function SessionsPage() {
  // SessionsClient reads the query string (useSearchParams), which a
  // statically rendered page must hold inside a Suspense boundary.
  return (
    <Suspense>
      <SessionsClient />
    </Suspense>
  );
}
