import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { runCanvasAgent, type AgentEvent } from "@/app/canvas/lib/canvas-agent";
import { authorizeLlm } from "@/app/canvas/lib/models";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const TRANSCRIPT_TURNS = 10;

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  // Typed as plain strings, not Provider: this is unvalidated client input
  // until authorizeLlm below says otherwise.
  let body: { chatId?: string; provider?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { chatId, provider, model } = body;
  if (!chatId || !provider || !model) {
    return NextResponse.json(
      { error: "chatId, provider, and model are required" },
      { status: 400 },
    );
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_CONVEX_URL not set" },
      { status: 500 },
    );
  }
  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(token);

  const viewer = await convex.query(api.users.viewer);
  if (!viewer) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Both halves of the client-supplied pair are checked here. The browser's
  // resolveLlm also checks the model, but it runs in the caller's own process
  // and is therefore not a gate: without this, any signed-in account could post
  // an arbitrary model string for a provider billed to Tom.
  const authorized = authorizeLlm({ provider, model }, viewer.isTom);
  if (!authorized.ok) {
    return authorized.reason === "provider"
      ? NextResponse.json(
          { error: "Provider not available for your role" },
          { status: 403 },
        )
      : NextResponse.json(
          { error: "Model not available for this provider" },
          { status: 400 },
        );
  }

  const messages = await convex.query(api.canvas.getMessages, {
    chatId: chatId as Id<"canvasChats">,
  });
  if (messages.length === 0) {
    return NextResponse.json({ error: "Chat is empty" }, { status: 400 });
  }
  const canvasId = messages[0].canvasId;
  const canvas = await convex.query(api.canvas.get, { id: canvasId });

  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.kind === "user");
  if (!lastUserMessage) {
    return NextResponse.json({ error: "No user message to respond to" }, { status: 400 });
  }
  const userText = String(lastUserMessage.content);

  const transcript = messages
    .filter((m) => m.kind === "user" || m.kind === "assistant_text")
    .slice(-TRANSCRIPT_TURNS)
    .map((m) => `${m.kind === "user" ? "User" : "Assistant"}: ${String(m.content)}`)
    .join("\n");

  const systemPrompt = [
    "You are editing canvas.html, the user's web page.",
    "Use only the read, write, and edit tools. Never run bash.",
    "After your edits, briefly tell the user what you changed.",
    "",
    "Recent conversation:",
    transcript,
  ].join("\n");

  const handleEvent = async (event: AgentEvent) => {
    if (event.kind === "html_changed") {
      await convex.mutation(api.canvas.setHtml, {
        id: canvasId,
        html: event.html,
      });
      return;
    }
    await convex.mutation(api.canvas.appendMessage, {
      chatId: chatId as Id<"canvasChats">,
      kind: event.kind,
      content:
        event.kind === "tool_call"
          ? { tool: event.tool, args: event.args }
          : event.kind === "tool_result"
            ? { ok: event.ok, output: event.output }
            : event.content,
    });
  };

  try {
    await runCanvasAgent({
      initialHtml: canvas.html,
      systemPrompt,
      userMessage: userText,
      provider: authorized.provider,
      model: authorized.model,
      onEvent: handleEvent,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Agent failed";
    await convex
      .mutation(api.canvas.appendMessage, {
        chatId: chatId as Id<"canvasChats">,
        kind: "error",
        content: message,
      })
      .catch(() => {});
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
