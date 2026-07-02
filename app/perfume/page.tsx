import type { Metadata } from "next";
import PerfumeClient from "./perfume-client";

export const metadata: Metadata = {
  title: "Perfume | tom.Quest",
  description:
    "The Three Feifs perfumer's bench — drop ingredients into the cauldron, watch their magical frequencies float up, spend strikes and wildcards, and brew the perfume.",
};

export default function PerfumePage() {
  return <PerfumeClient />;
}
