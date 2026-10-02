import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Dump | tom.Quest",
  robots: { index: false, follow: false },
};

export default function DumpPage() {
  // Kept for the link Tom was sent to judge the mockup: the redirect takes
  // that /mock/dump link to the real page it became.
  redirect("/thread");
}
