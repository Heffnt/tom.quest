import type { Metadata } from "next";
import QuestionsClient from "./questions-client";

export const metadata: Metadata = {
  title: "Questions | tom.Quest",
  description: "One conversation question at a time, by depth.",
};

export default function QuestionsPage() {
  return <QuestionsClient />;
}
