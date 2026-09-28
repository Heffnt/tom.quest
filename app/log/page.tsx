import type { Metadata } from "next";
import LogClient from "./log-client";

export const metadata: Metadata = {
  title: "Log | tom.Quest",
  description: "A private day log for Tom.",
};

export default function LogPage() {
  return <LogClient />;
}
