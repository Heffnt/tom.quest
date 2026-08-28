import type { Metadata } from "next";
import DtsClient from "./dts-client";

export const metadata: Metadata = {
  title: "TTS | tom.Quest",
  description: "Toms Todo System.",
};

export default function DtsPage() {
  return <DtsClient />;
}
