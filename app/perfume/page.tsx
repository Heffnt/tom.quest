import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Perfume | tom.Quest",
  description:
    "The Three Feifs perfumer's bench — combine ingredients, watch the magical frequencies of your brew assemble, and discover which perfume recipe you've satisfied.",
};

// The bench is a self-contained single-page app (its own data + styles + fonts)
// shipped from public/byobu/bench.html. Embedding it in an iframe keeps that
// artifact intact rather than re-porting it into React. Sized to the viewport
// below the 4rem docked nav (see AppShell's pt-16).
export default function PerfumePage() {
  return (
    <iframe
      src="/byobu/bench.html"
      title="Three Feifs Perfumer's Bench"
      className="block w-full h-[calc(100vh-4rem)] border-0"
    />
  );
}
