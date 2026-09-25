import type { Metadata } from "next";
import VocabularyClient from "./vocabulary-client";

export const metadata: Metadata = {
  title: "Vocabulary | tom.Quest",
  description: "Every word TTS uses, as an agent's tts search prints it.",
};

export default function VocabularyPage() {
  return <VocabularyClient />;
}
