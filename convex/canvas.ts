import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireViewerId } from "./authRoles";

const STARTER_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>New canvas</title></head>
  <body>
    <h1>Hello, world.</h1>
    <p>Tell the agent what you want this page to be.</p>
  </body>
</html>
`;

async function ownCanvasOrThrow(
  ctx: QueryCtx | MutationCtx,
  canvasId: Id<"canvases">,
  userId: Id<"users">,
): Promise<Doc<"canvases">> {
  const canvas = await ctx.db.get(canvasId);
  if (!canvas || canvas.userId !== userId) {
    throw new Error("Canvas not found");
  }
  return canvas;
}

async function ownChatOrThrow(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"canvasChats">,
  userId: Id<"users">,
): Promise<Doc<"canvasChats">> {
  const chat = await ctx.db.get(chatId);
  if (!chat || chat.userId !== userId) {
    throw new Error("Chat not found");
  }
  return chat;
}

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireViewerId(ctx);
    const rows = await ctx.db
      .query("canvases")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    return rows.map((row) => ({
      _id: row._id,
      name: row.name,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      activeChatId: row.activeChatId,
    }));
  },
});

export const get = query({
  args: { id: v.id("canvases") },
  handler: async (ctx, { id }) => {
    const userId = await requireViewerId(ctx);
    const canvas = await ownCanvasOrThrow(ctx, id, userId);
    return canvas;
  },
});

export const create = mutation({
  args: { name: v.optional(v.string()) },
  handler: async (ctx, { name }) => {
    const userId = await requireViewerId(ctx);
    const now = Date.now();
    const canvasId = await ctx.db.insert("canvases", {
      userId,
      name: name ?? "Untitled canvas",
      html: STARTER_HTML,
      createdAt: now,
      updatedAt: now,
    });
    const chatId = await ctx.db.insert("canvasChats", {
      canvasId,
      userId,
      createdAt: now,
      lastActivityAt: now,
    });
    await ctx.db.patch(canvasId, { activeChatId: chatId });
    return { canvasId, chatId };
  },
});

export const rename = mutation({
  args: { id: v.id("canvases"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    const userId = await requireViewerId(ctx);
    await ownCanvasOrThrow(ctx, id, userId);
    await ctx.db.patch(id, { name, updatedAt: Date.now() });
  },
});

export const setHtml = mutation({
  args: { id: v.id("canvases"), html: v.string() },
  handler: async (ctx, { id, html }) => {
    const userId = await requireViewerId(ctx);
    await ownCanvasOrThrow(ctx, id, userId);
    await ctx.db.patch(id, { html, updatedAt: Date.now() });
  },
});

export const duplicate = mutation({
  args: { id: v.id("canvases") },
  handler: async (ctx, { id }) => {
    const userId = await requireViewerId(ctx);
    const source = await ownCanvasOrThrow(ctx, id, userId);
    const now = Date.now();
    const newCanvasId = await ctx.db.insert("canvases", {
      userId,
      name: `${source.name} (copy)`,
      html: source.html,
      createdAt: now,
      updatedAt: now,
    });
    const chatId = await ctx.db.insert("canvasChats", {
      canvasId: newCanvasId,
      userId,
      createdAt: now,
      lastActivityAt: now,
    });
    await ctx.db.patch(newCanvasId, { activeChatId: chatId });
    return { canvasId: newCanvasId, chatId };
  },
});

export const remove = mutation({
  args: { id: v.id("canvases") },
  handler: async (ctx, { id }) => {
    const userId = await requireViewerId(ctx);
    await ownCanvasOrThrow(ctx, id, userId);
    const chats = await ctx.db
      .query("canvasChats")
      .withIndex("by_canvas_activity", (q) => q.eq("canvasId", id))
      .collect();
    for (const chat of chats) {
      const messages = await ctx.db
        .query("canvasMessages")
        .withIndex("by_chat_created", (q) => q.eq("chatId", chat._id))
        .collect();
      for (const message of messages) await ctx.db.delete(message._id);
      await ctx.db.delete(chat._id);
    }
    await ctx.db.delete(id);
  },
});

export const listChats = query({
  args: { canvasId: v.id("canvases") },
  handler: async (ctx, { canvasId }) => {
    const userId = await requireViewerId(ctx);
    await ownCanvasOrThrow(ctx, canvasId, userId);
    const rows = await ctx.db
      .query("canvasChats")
      .withIndex("by_canvas_activity", (q) => q.eq("canvasId", canvasId))
      .order("desc")
      .collect();
    return rows;
  },
});

export const createChat = mutation({
  args: { canvasId: v.id("canvases") },
  handler: async (ctx, { canvasId }) => {
    const userId = await requireViewerId(ctx);
    await ownCanvasOrThrow(ctx, canvasId, userId);
    const now = Date.now();
    const chatId = await ctx.db.insert("canvasChats", {
      canvasId,
      userId,
      createdAt: now,
      lastActivityAt: now,
    });
    await ctx.db.patch(canvasId, { activeChatId: chatId });
    return chatId;
  },
});

export const removeChat = mutation({
  args: { chatId: v.id("canvasChats") },
  handler: async (ctx, { chatId }) => {
    const userId = await requireViewerId(ctx);
    const chat = await ownChatOrThrow(ctx, chatId, userId);
    const messages = await ctx.db
      .query("canvasMessages")
      .withIndex("by_chat_created", (q) => q.eq("chatId", chatId))
      .collect();
    for (const message of messages) await ctx.db.delete(message._id);
    await ctx.db.delete(chatId);

    const canvas = await ctx.db.get(chat.canvasId);
    if (canvas && canvas.activeChatId === chatId) {
      const fallback = await ctx.db
        .query("canvasChats")
        .withIndex("by_canvas_activity", (q) => q.eq("canvasId", chat.canvasId))
        .order("desc")
        .first();
      await ctx.db.patch(chat.canvasId, {
        activeChatId: fallback?._id ?? undefined,
      });
    }
  },
});

export const setActiveChat = mutation({
  args: { canvasId: v.id("canvases"), chatId: v.id("canvasChats") },
  handler: async (ctx, { canvasId, chatId }) => {
    const userId = await requireViewerId(ctx);
    await ownCanvasOrThrow(ctx, canvasId, userId);
    const chat = await ownChatOrThrow(ctx, chatId, userId);
    if (chat.canvasId !== canvasId) {
      throw new Error("Chat does not belong to this canvas");
    }
    await ctx.db.patch(canvasId, { activeChatId: chatId });
  },
});

export const getMessages = query({
  args: { chatId: v.id("canvasChats") },
  handler: async (ctx, { chatId }) => {
    const userId = await requireViewerId(ctx);
    await ownChatOrThrow(ctx, chatId, userId);
    const rows = await ctx.db
      .query("canvasMessages")
      .withIndex("by_chat_created", (q) => q.eq("chatId", chatId))
      .order("asc")
      .collect();
    return rows;
  },
});

export const appendMessage = mutation({
  args: {
    chatId: v.id("canvasChats"),
    kind: v.union(
      v.literal("user"),
      v.literal("assistant_text"),
      v.literal("tool_call"),
      v.literal("tool_result"),
      v.literal("system_prompt"),
      v.literal("error"),
    ),
    content: v.any(),
  },
  handler: async (ctx, { chatId, kind, content }) => {
    const userId = await requireViewerId(ctx);
    const chat = await ownChatOrThrow(ctx, chatId, userId);
    const now = Date.now();
    const messageId = await ctx.db.insert("canvasMessages", {
      chatId,
      canvasId: chat.canvasId,
      userId,
      kind,
      content,
      createdAt: now,
    });
    await ctx.db.patch(chatId, { lastActivityAt: now });
    await ctx.db.patch(chat.canvasId, { updatedAt: now });
    return messageId;
  },
});

