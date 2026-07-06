import type { Metadata } from "next";
import PerfumeClient from "../../perfume-client";

export const metadata: Metadata = {
  title: "Perfume | tom.Quest",
  description:
    "A brew on the Three Feifs perfumer's cauldron — drop ingredients, watch their magical frequencies float up, spend strikes and wildcards, and brew the perfume.",
};

// Deep link to a single brew (DESIGN.md §4 — every brew has a shareable URL
// /perfume/b/[id]). Same client, opened on the given brew id.
export default async function PerfumeBrewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PerfumeClient brewId={id} />;
}
