import { notFound } from "next/navigation";
import TerminalHarnessClient from "./harness-client";

// Test fixture, not a product page. The terminal modal normally opens from the
// jobs table, which only renders for a Convex-authenticated admin, so an
// automated browser check cannot reach the modal without real admin
// credentials. This route mounts the same TerminalModal component directly so
// e2e/terminal-surfaces.spec.ts can drive it. It answers 404 unless
// TERMINAL_HARNESS is "1", a server-only variable that is set in a local
// .env.local and is not set in Vercel, so the route does not exist in
// production. It is deliberately absent from app/components/page-routes.ts and
// therefore never appears in navigation.

// Evaluated per request rather than baked in at build time, so the guard below
// reflects the running server's environment and never a build machine's.
export const dynamic = "force-dynamic";

export default function TerminalHarnessPage() {
  if (process.env.TERMINAL_HARNESS !== "1") notFound();
  return <TerminalHarnessClient />;
}
