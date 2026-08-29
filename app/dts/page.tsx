import type { Metadata } from "next";
import DtsClient from "./dts-client";

export const metadata: Metadata = {
  title: "TTS | tom.Quest",
  description: "Tom's Todo System.",
};

export default function DtsPage() {
  return <DtsClient />;
}
