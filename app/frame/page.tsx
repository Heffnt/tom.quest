import type { Metadata } from "next";
import FrameClient from "./frame-client";

export const metadata: Metadata = {
  title: "Frame | tom.Quest",
  description: "Every component of the jarvis pages, laid out in the frame.",
};

export default function FramePage() {
  return <FrameClient />;
}
