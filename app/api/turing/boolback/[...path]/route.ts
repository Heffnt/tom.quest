import { NextRequest, NextResponse } from "next/server";
import { fetchTuring } from "@/app/lib/turing";
import { isTomUser } from "@/app/lib/supabase";

type RouteParams = {
  path: string[];
};

function buildTargetPath(segments: string[], searchParams: URLSearchParams): string {
  const suffix = segments.length > 0 ? `/${segments.join("/")}` : "";
  const query = searchParams.toString();
  return `/boolback${suffix}${query ? `?${query}` : ""}`;
}

async function proxyResponse(res: Response): Promise<NextResponse> {
  const contentType = res.headers.get("content-type") || "application/json";
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "Content-Type": contentType },
  });
}

export async function GET(request: NextRequest, context: { params: Promise<RouteParams> }) {
  try {
    const userId = request.headers.get("x-user-id") || undefined;
    const { path } = await context.params;
    const targetPath = buildTargetPath(path, request.nextUrl.searchParams);
    const res = await fetchTuring(targetPath, { cache: "no-store" }, userId);
    return proxyResponse(res);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest, context: { params: Promise<RouteParams> }) {
  const userId = request.headers.get("x-user-id") || undefined;
  if (!isTomUser(userId)) {
    return NextResponse.json({ error: "Only Tom can validate samples" }, { status: 403 });
  }
  try {
    const { path } = await context.params;
    const targetPath = buildTargetPath(path, request.nextUrl.searchParams);
    const contentType = request.headers.get("content-type") || "application/json";
    const bodyText = await request.text();
    const res = await fetchTuring(
      targetPath,
      {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: bodyText,
      },
      userId
    );
    return proxyResponse(res);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
