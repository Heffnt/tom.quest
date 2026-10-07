import { redirect } from "next/navigation";

// The removed Inventory surface now lands on sessions. Old links — including
// ttsItemLink's ?item= deep links from Slack — retain their query.
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  if (typeof sp.item === "string") qs.set("item", sp.item);
  if (typeof sp.intent === "string") qs.set("intent", sp.intent);
  const q = qs.toString();
  redirect(q ? `/sessions?${q}` : "/sessions");
}
