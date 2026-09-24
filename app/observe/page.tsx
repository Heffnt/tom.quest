import type { Metadata } from "next";
import ObserveClient from "./observe-client";

export const metadata: Metadata = {
  title: "Observe | tom.Quest",
  description: "Everything that ran and every ruling, by window.",
};

export default function ObservePage() {
  return <ObserveClient />;
}
