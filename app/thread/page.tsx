import type { Metadata } from "next";
import ThreadClient from "./thread-client";

export const metadata: Metadata = {
  title: "Jarvis thread | tom.Quest",
  robots: { index: false, follow: false },
};

export default function ThreadPage() {
  return <ThreadClient />;
}
