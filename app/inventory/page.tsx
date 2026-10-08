import { redirect } from "next/navigation";

// The removed Inventory surface now lands on sessions. Its old todo deep links (?item=, ?intent=)
// are not carried: no page shows a single todo since the /jarvis page went,
// so the sessions page has nothing to open with them.
export default function InventoryPage() {
  redirect("/sessions");
}
