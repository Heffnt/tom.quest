import type { Metadata } from "next";
import SecretsClient from "./secrets-client";

export const metadata: Metadata = {
  title: "Secrets | tom.Quest",
  description: "Values handed to the Jarvis Box.",
};

export default function SecretsPage() {
  return <SecretsClient />;
}
