import type { Metadata } from "next";
import ThreadClient from "./thread-client";

export const metadata: Metadata = {
  title: "Jarvis thread | tom.Quest",
  robots: { index: false, follow: false },
  // The home-screen bookmark opens the thread.
  manifest: "/thread/manifest.webmanifest",
};

export default function ThreadPage() {
  return <ThreadClient />;
}
