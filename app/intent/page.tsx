import type { Metadata } from "next";
import IntentClient from "./intent-client";

export const metadata: Metadata = {
  title: "Intent | tom.Quest",
  description: "Every line of Tom's intent, from every place it is written.",
};

export default function IntentPage() {
  return <IntentClient />;
}
