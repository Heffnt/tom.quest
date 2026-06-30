import type { Metadata } from "next";
import ForgeClient from "./forge-client";

export const metadata: Metadata = {
  title: "Forge | tom.Quest",
  description: "Build and train boolean-trigger backdoors, then chat with the result.",
};

export default function ForgePage() {
  return <ForgeClient />;
}
