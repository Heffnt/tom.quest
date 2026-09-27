import type { Metadata } from "next";
import { Suspense } from "react";
import AgentsClient from "./agents-client";

export const metadata: Metadata = {
  title: "Agents | tom.Quest",
  description:
    "TTS Agents — every agent on the Jarvis Box, sessions and agents that are not sessions: transcripts, controls.",
};

export default function AgentsPage() {
  // AgentsClient reads the query string (useSearchParams), which a statically
  // rendered page must hold inside a Suspense boundary.
  return (
    <Suspense>
      <AgentsClient />
    </Suspense>
  );
}
