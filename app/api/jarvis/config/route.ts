import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/app/lib/supabase";
import { isTom } from "@/app/lib/turing";

type GatewayDeviceIdentityPayload = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

async function getUserId(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;
  const supabase = createServerSupabaseClient();
  if (!supabase) return null;
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  const { data } = await supabase.auth.getUser(token);
  return data.user?.id ?? null;
}

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function getGatewayDeviceIdentity() {
  const deviceId = readOptionalEnv("JARVIS_DEVICE_ID");
  const publicKey = readOptionalEnv("JARVIS_DEVICE_PUBLIC_KEY");
  const privateKey = readOptionalEnv("JARVIS_DEVICE_PRIVATE_KEY");
  const configuredValues = [deviceId, publicKey, privateKey].filter(Boolean).length;
  if (configuredValues === 0) {
    return { identity: null, error: null } as const;
  }
  if (configuredValues !== 3) {
    return {
      identity: null,
      error: "Shared Jarvis gateway identity is incomplete",
    } as const;
  }
  return {
    identity: {
      deviceId: deviceId!,
      publicKey: publicKey!,
      privateKey: privateKey!,
    } satisfies GatewayDeviceIdentityPayload,
    error: null,
  } as const;
}

export async function GET(request: NextRequest) {
  const userId = await getUserId(request);
  if (!isTom(userId || undefined)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  if (!gatewayUrl) {
    return NextResponse.json({ error: "Gateway not configured" }, { status: 503 });
  }
  const gatewayPassword = process.env.JARVIS_GATEWAY_PASSWORD?.trim() || null;
  if (!gatewayPassword) {
    return NextResponse.json({ error: "Gateway password not configured" }, { status: 503 });
  }
  const { identity: gatewayDeviceIdentity, error } = getGatewayDeviceIdentity();
  if (error) {
    return NextResponse.json({ error }, { status: 503 });
  }
  return NextResponse.json({ gatewayUrl, gatewayPassword, gatewayDeviceIdentity });
}
