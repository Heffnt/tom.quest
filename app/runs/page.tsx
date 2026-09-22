import type { Metadata } from "next";
import RunsClient from "./runs-client";

export const metadata: Metadata = {
  title: "Runs | tom.Quest",
  description:
    "TTS Runs — every agent run on the Jarvis Box, sessions and non-session runs: transcripts, controls.",
};

export default function RunsPage() {
  return <RunsClient />;
}
