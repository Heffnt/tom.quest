import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT, resolveWorkspacePath } from "@/app/api/jarvis/_utils";
import { requireTom } from "@/app/lib/convex-server";

export async function GET(request: NextRequest) {
  const auth = await requireTom(request);
  if (auth instanceof Response) return auth;

  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "read";

  if (action === "list") {
    const prefix = searchParams.get("prefix") || "";
    const absolutePrefix = resolveWorkspacePath(prefix);
    let entries: Array<{ path: string; name: string; type: "file" | "dir"; size?: number }> = [];
    try {
      const dirEntries = await fs.readdir(absolutePrefix, { withFileTypes: true });
      entries = await Promise.all(
        dirEntries.map(async (entry) => {
          const absolute = path.join(absolutePrefix, entry.name);
          const stat = entry.isFile() ? await fs.stat(absolute) : null;
          return {
            path: path.relative(WORKSPACE_ROOT, absolute),
            name: entry.name,
            type: entry.isDirectory() ? "dir" : "file",
            size: stat?.size,
          } as const;
        }),
      );
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to list files" }, { status: 500 });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ prefix, entries });
  }

  const relativePath = searchParams.get("path");
  if (!relativePath) {
    return NextResponse.json({ error: "Missing path" }, { status: 400 });
  }
  try {
    const absolutePath = resolveWorkspacePath(relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    return NextResponse.json({ path: relativePath, content });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to read file" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireTom(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => null)) as { path?: string; content?: string } | null;
  if (!body?.path || typeof body.content !== "string") {
    return NextResponse.json({ error: "Missing path or content" }, { status: 400 });
  }
  try {
    const absolutePath = resolveWorkspacePath(body.path);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, body.content, "utf8");
    return NextResponse.json({ ok: true, path: body.path });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to write file" }, { status: 500 });
  }
}
