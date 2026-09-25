import type { Metadata } from "next";
import IntentClient from "./intent-client";

export const metadata: Metadata = {
  title: "Intent | tom.Quest",
  description: "Tom's intent as an agent reads it, and every line of it from every place it is written.",
};

export default function IntentPage() {
  return <IntentClient />;
}
