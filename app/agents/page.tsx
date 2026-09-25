import type { Metadata } from "next";
import AgentsClient from "./agents-client";

export const metadata: Metadata = {
  title: "Agents | tom.Quest",
  description:
    "TTS Agents — every agent on the Jarvis Box, sessions and agents that are not sessions: transcripts, controls.",
};

export default function AgentsPage() {
  return <AgentsClient />;
}
