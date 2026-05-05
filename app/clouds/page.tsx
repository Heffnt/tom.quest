import type { Metadata } from "next";
import CloudsClientPage from "./clouds-client-page";

export const metadata: Metadata = {
  title: "Clouds | tom.Quest",
  description: "Interactive LiDAR point cloud viewer.",
};

export default function CloudsPage() {
  return <CloudsClientPage />;
}
