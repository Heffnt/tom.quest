import type { Metadata } from "next";
import CanvasClient from "./canvas-client";

export const metadata: Metadata = {
  title: "Canvas | tom.Quest",
  description: "Chat-driven HTML canvas builder.",
};

export default function CanvasPage() {
  return <CanvasClient />;
}
