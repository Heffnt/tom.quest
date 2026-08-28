import { redirect } from "next/navigation";

// The Inventory surface merged into /dts (everything tab). Old links —
// including dtsItemLink's ?item=&intent= deep links from Slack — land here,
// so the params are carried across.
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
  redirect(q ? `/dts?${q}` : "/dts");
}
