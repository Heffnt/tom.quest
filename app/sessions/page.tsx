import type { Metadata } from "next";
import SessionsClient from "./sessions-client";

export const metadata: Metadata = {
  title: "Sessions | tom.Quest",
  description:
    "TTS Sessions — Claude Code sessions on the worker box: transcripts, permission requests, controls.",
};

export default function SessionsPage() {
  return <SessionsClient />;
}
