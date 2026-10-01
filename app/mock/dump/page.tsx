import type { Metadata } from "next";
import DumpClient from "./dump-client";

export const metadata: Metadata = {
  title: "Dump | tom.Quest",
  robots: { index: false, follow: false },
};

export default function DumpPage() {
  return <DumpClient />;
}
