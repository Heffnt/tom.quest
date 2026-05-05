import type { Metadata } from "next";
import LogoClient from "./logo-client";

export const metadata: Metadata = {
  title: "Logo | tom.Quest",
  description: "Parametric tom.Quest logo and symbol lab.",
};

export default function LogoPage() {
  return <LogoClient />;
}
