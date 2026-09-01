import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/convex-server";
import { signWsToken } from "@/app/lib/turing";

const TOKEN_TTL_MS = 5 * 60 * 1000;

// requireAdmin, NOT the read gate the /turing proxy's GET takes, even though
// this is also a GET: what it returns is a signed ticket for an interactive
// shell on the cluster. The read-only `agent` role may look at a page; a shell
// is not looking at a page.
export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const sessionName = new URL(request.url).searchParams.get("session") ?? "";
  if (!sessionName) {
    return NextResponse.json({ error: "Missing session" }, { status: 400 });
  }
  try {
    const creds = signWsToken({
      userId: auth._id,
      sessionName,
      ttlMs: TOKEN_TTL_MS,
    });
    return NextResponse.json(creds);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 },
    );
  }
}
