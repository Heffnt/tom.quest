import type { Metadata } from "next";
import TuringClient from "./turing-client";

export const metadata: Metadata = {
  title: "Turing | tom.Quest",
  description: "GPU allocation and job monitoring for the WPI Turing cluster.",
};

export default function TuringPage() {
  return <TuringClient />;
}
