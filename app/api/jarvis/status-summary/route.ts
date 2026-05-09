import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { currentDayKey, OPENCLAW_ROOT, WORKSPACE_ROOT } from "@/app/api/jarvis/_utils";
import { requireTom } from "@/app/lib/convex-server";

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireTom(request);
  if (auth instanceof Response) return auth;

  const openclawConfig = await readJson<Record<string, unknown>>(path.join(OPENCLAW_ROOT, "openclaw.json"));
  const providerCosts = await readJson<Record<string, unknown>>(path.join(WORKSPACE_ROOT, "memory/provider-costs/summary.json"));
  const localTokenSummary = await readJson<Record<string, unknown>>(path.join(WORKSPACE_ROOT, "memory/token-usage/summary.json"));

  const providers = (openclawConfig?.providers as Record<string, unknown> | undefined) ?? {};
  const openaiProvider = (providers.openai as Record<string, unknown> | undefined) ?? null;
  const anthropicProvider = (providers.anthropic as Record<string, unknown> | undefined) ?? null;

  const today = currentDayKey();
  const dailyTotals = ((localTokenSummary?.dailyTotals as Record<string, unknown> | undefined) ?? {});
  const todayLocal = (dailyTotals[today] as Record<string, unknown> | undefined) ?? null;

  return NextResponse.json({
    today,
    codex: {
      configured: Boolean(openaiProvider),
      auth: typeof openaiProvider?.auth === "string" ? openaiProvider.auth : null,
      label: openaiProvider ? `Codex ${typeof openaiProvider.auth === "string" ? openaiProvider.auth : "configured"}` : "Codex unavailable",
    },
    anthropic: {
      configured: Boolean(anthropicProvider),
      auth: typeof anthropicProvider?.auth === "string" ? anthropicProvider.auth : null,
      label: anthropicProvider ? `Anthropic ${typeof anthropicProvider.auth === "string" ? anthropicProvider.auth : "configured"}` : "Anthropic unavailable",
    },
    providerCosts,
    localUsage: {
      today: todayLocal,
      summary: localTokenSummary,
    },
  });
}
