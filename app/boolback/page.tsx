import type { Metadata } from "next";
import BoolbackClient from "./boolback-client";

export const metadata: Metadata = {
  title: "Boolback | tom.Quest",
  description: "Boolean-backdoor artifact-tree explorer.",
};

export default function BoolbackPage() {
  return <BoolbackClient />;
}
