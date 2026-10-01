import type { Metadata } from "next";
import MockIntentClient from "./mock-intent-client";

export const metadata: Metadata = {
  title: "Intent mockup | tom.Quest",
};

export default function MockIntentPage() {
  return <MockIntentClient />;
}
