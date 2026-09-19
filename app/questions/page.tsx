import type { Metadata } from "next";
import QuestionsClient from "./questions-client";

export const metadata: Metadata = {
  title: "Questions | tom.Quest",
  description: "One question at a time, by kind, frame and topic.",
};

export default function QuestionsPage() {
  return <QuestionsClient />;
}
