import { NextRequest, NextResponse } from "next/server";
import { requireTom } from "@/app/lib/convex-server";

type GatewayDeviceIdentityPayload = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

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
  try {
    await requireTom(request);
  } catch {
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
