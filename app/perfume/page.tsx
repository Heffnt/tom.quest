import type { Metadata } from "next";
import PerfumeClient from "./perfume-client";

export const metadata: Metadata = {
  title: "Perfume | tom.Quest",
  description:
    "The Three Feifs perfumery — drop ingredients into the cauldron, watch their magical frequencies float up, spend strikes and wildcards, and brew the perfume.",
};

// /perfume opens the viewer's most recent brew, or the party brew for a
// visitor (route context resolved client-side). A deep link lives at
// /perfume/b/[id].
export default function PerfumePage() {
  return <PerfumeClient />;
}
