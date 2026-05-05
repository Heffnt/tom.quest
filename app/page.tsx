import type { Metadata } from "next";
import HomeClient from "./home-client";

export const metadata: Metadata = {
  title: "tom.Quest",
  description: "Tom Heffernan's personal site and tool dashboard.",
};

export default function Home() {
  return <HomeClient />;
}
