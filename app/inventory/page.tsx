import type { Metadata } from "next";
import InventoryClient from "./inventory-client";

export const metadata: Metadata = {
  title: "Inventory | tom.Quest",
  description: "DTS Inventory — everything, always: every todo, its age, and where it stands.",
};

export default function InventoryPage() {
  return <InventoryClient />;
}
