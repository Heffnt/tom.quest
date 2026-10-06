import type { Metadata } from "next";
import { Suspense } from "react";
import DesignClient from "./design-client";

export const metadata: Metadata = {
  title: "Design | tom.Quest",
  description: "Every part of Jarvis drawn, with its sentences, state and numbers.",
};

export default function DesignPage() {
  // DesignClient reads the query string (useSearchParams), which a statically
  // rendered page must hold inside a Suspense boundary.
  return (
    <Suspense>
      <DesignClient />
    </Suspense>
  );
}
