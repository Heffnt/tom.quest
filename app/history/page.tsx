import type { Metadata } from "next";
import HistoryClient from "./history-client";

export const metadata: Metadata = {
  title: "History | tom.Quest",
  description: "Tom's diet and exercise, what he told Jarvis, and what Jarvis did, by day.",
};

export default function HistoryPage() {
  return <HistoryClient />;
}
