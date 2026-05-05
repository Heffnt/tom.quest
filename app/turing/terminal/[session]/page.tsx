import type { Metadata } from "next";
import TerminalClient from "./terminal-client";

export const metadata: Metadata = {
  title: "Turing Terminal | tom.Quest",
  description: "Interactive Turing cluster terminal session viewer.",
};

export default function TerminalPage() {
  return <TerminalClient />;
}
