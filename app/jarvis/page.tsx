import type { Metadata } from "next";
import JarvisClient from "./jarvis-client";

export const metadata: Metadata = {
  title: "Jarvis | tom.Quest",
  description: "Tom's personal AI assistant dashboard.",
};

export default function JarvisPage() {
  return <JarvisClient />;
}
