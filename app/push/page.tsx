import type { Metadata } from "next";
import PushClient from "./push-client";

export const metadata: Metadata = {
  title: "Push | tom.Quest",
};

// Unlisted on purpose: not in PAGES, like /focus and /mock, so it stays out of the navigation; TomGate and requireTom gate it.
export default function PushPage() {
  return <PushClient />;
}
