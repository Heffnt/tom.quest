import type { Metadata } from "next";
import JarvisClient from "./jarvis-client";

export const metadata: Metadata = {
  title: "Jarvis | tom.Quest",
  description: "Tom's todos, his calendar and what waits on his ruling.",
};

export default function JarvisPage() {
  return <JarvisClient />;
}
