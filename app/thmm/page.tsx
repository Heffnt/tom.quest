import type { Metadata } from "next";
import THMMClient from "./thmm-client";

export const metadata: Metadata = {
  title: "THMM | tom.Quest",
  description: "Tiny CPU simulator and datapath visualizer.",
};

export default function THMMPage() {
  return <THMMClient />;
}
