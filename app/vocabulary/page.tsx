import type { Metadata } from "next";
import VocabularyClient from "./vocabulary-client";

export const metadata: Metadata = {
  title: "Vocabulary | tom.Quest",
  description: "Every word TTS uses, what it means, and where it is defined.",
};

export default function VocabularyPage() {
  return <VocabularyClient />;
}
