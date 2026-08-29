import type { Metadata } from "next";
import MockupClient from "./mockup-client";

export const metadata: Metadata = {
  title: "TTS mockup | tom.Quest",
  description: "Batches redesign mockup over a prod data snapshot.",
};

export default function TtsMockupPage() {
  return <MockupClient />;
}
