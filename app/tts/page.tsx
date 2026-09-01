import type { Metadata } from "next";
import TtsClient from "./tts-client";

export const metadata: Metadata = {
  title: "TTS | tom.Quest",
  description: "Toms Todo System.",
};

export default function TtsPage() {
  return <TtsClient />;
}
