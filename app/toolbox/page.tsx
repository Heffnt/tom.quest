import type { Metadata } from "next";
import ToolboxClient from "./toolbox-client";

export const metadata: Metadata = {
  title: "Toolbox | tom.Quest",
  description: "Every component once, with live data.",
};

export default function ToolboxPage() {
  return <ToolboxClient />;
}
