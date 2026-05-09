import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const USER_ROLES = v.union(
  v.literal("user"),
  v.literal("admin"),
  v.literal("tom"),
);

export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    role: v.optional(USER_ROLES),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  turingConnections: defineTable({
    connectionKey: v.string(),
    tunnelUrl: v.string(),
    userId: v.optional(v.id("users")),
    lastHeartbeat: v.number(),
  })
    .index("by_connection_key", ["connectionKey"])
    .index("by_user_id", ["userId"]),

  userSettings: defineTable({
    userId: v.id("users"),
    settingKey: v.string(),
    value: v.any(),
    updatedAt: v.number(),
  }).index("by_user_setting", ["userId", "settingKey"]),

  symbolScores: defineTable({
    userId: v.optional(v.id("users")),
    username: v.string(),
    timeMs: v.number(),
    createdAt: v.number(),
  }).index("by_time", ["timeMs"]),

  canvases: defineTable({
    userId: v.id("users"),
    name: v.string(),
    html: v.string(),
    activeChatId: v.optional(v.id("canvasChats")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_updated", ["userId", "updatedAt"]),

  canvasChats: defineTable({
    canvasId: v.id("canvases"),
    userId: v.id("users"),
    createdAt: v.number(),
    lastActivityAt: v.number(),
  })
    .index("by_canvas_activity", ["canvasId", "lastActivityAt"])
    .index("by_user", ["userId"]),

  canvasMessages: defineTable({
    chatId: v.id("canvasChats"),
    canvasId: v.id("canvases"),
    userId: v.id("users"),
    kind: v.union(
      v.literal("user"),
      v.literal("assistant_text"),
      v.literal("tool_call"),
      v.literal("tool_result"),
      v.literal("system_prompt"),
      v.literal("error"),
    ),
    content: v.any(),
    createdAt: v.number(),
  }).index("by_chat_created", ["chatId", "createdAt"]),
});
