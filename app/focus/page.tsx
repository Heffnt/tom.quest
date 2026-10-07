import { redirect } from "next/navigation";

// The Focus surface now lands on sessions. Its retired todo deep links remain
// in the address for compatibility with old Slack posts.
export default async function FocusPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  if (typeof sp.item === "string") qs.set("item", sp.item);
  if (typeof sp.intent === "string") qs.set("intent", sp.intent);
  const query = qs.toString();
  redirect(query === "" ? "/sessions" : `/sessions?${query}`);
}
