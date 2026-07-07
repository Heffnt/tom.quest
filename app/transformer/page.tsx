import type { Metadata } from "next";
import TransformerClient from "./transformer-client";

export const metadata: Metadata = {
  title: "Transformer | tom.Quest",
  description: "Drill into a real transformer: layers, heads, activations, raw weights.",
};

export default function TransformerPage() {
  return <TransformerClient />;
}
