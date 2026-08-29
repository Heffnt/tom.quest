import { redirect } from "next/navigation";

// The Focus surface merged into /tts (calendar tab). Any ?item=&intent= deep
// link is carried across (?item forces the everything tab client-side).
export default async function FocusPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams({ tab: "calendar" });
  if (typeof sp.item === "string") qs.set("item", sp.item);
  if (typeof sp.intent === "string") qs.set("intent", sp.intent);
  redirect(`/tts?${qs.toString()}`);
}
