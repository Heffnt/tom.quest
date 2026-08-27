import type { Metadata } from "next";
import FocusClient from "./focus-client";

export const metadata: Metadata = {
  title: "Focus | tom.Quest",
  description: "One task at a time from the DTS daily queue.",
};

export default function FocusPage() {
  return <FocusClient />;
}
