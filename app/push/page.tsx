import type { Metadata } from "next";
import PushClient from "./push-client";

export const metadata: Metadata = {
  title: "Push | tom.Quest",
};

export default function PushPage() {
  return <PushClient />;
}
