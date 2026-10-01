"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import Info from "@/app/jarvis/components/info";

const primaryBtnCls =
  "bg-accent text-bg rounded-md px-3 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-50 disabled:pointer-events-none";

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// A Convex error arrives wrapped in request ids and a stack; the refusal
// itself is the text after "Error: " up to the stack.
function refusal(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const match = /Uncaught Error: (.*?)(?:\n|\s+at |$)/.exec(text);
  return match ? match[1] : text;
}

export default function PushClient() {
  const { isTom } = useAuth();
  const publicKey = useQuery(api.push.vapidPublicKey, isTom ? undefined : "skip");
  const saveSubscription = useMutation(api.push.saveSubscription);
  const requestTest = useMutation(api.push.requestTest);

  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<boolean | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);

  useEffect(() => {
    const isSupported =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    setSupported(isSupported);
    if (!isSupported) return;
    setPermission(Notification.permission);
    navigator.serviceWorker
      .getRegistration("/")
      .then((registration) => registration?.pushManager.getSubscription() ?? null)
      .then((subscription) => setEndpoint(subscription?.endpoint ?? null))
      .catch(() => setEndpoint(null));
  }, []);

  const subscribe = async () => {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const granted = await Notification.requestPermission();
      if (granted !== "granted") throw new Error("permission not granted");
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const key = base64UrlToBytes(publicKey!);
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      const json = subscription.toJSON();
      await saveSubscription({
        subscription: {
          endpoint: json.endpoint!,
          expirationTime: json.expirationTime ?? null,
          keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth },
        },
      });
      setEndpoint(json.endpoint!);
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      await requestTest({ endpoint: endpoint! });
      setSent(true);
    } catch (err) {
      setSent(false);
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };

  const permissionLabel =
    supported === null
      ? "…"
      : supported
        ? (permission ?? "default")
        : "unsupported in this browser";
  const deviceLabel = endpoint ? "subscribed" : "not subscribed";

  return (
    <TomGate label="Push">
      <div className="max-w-3xl mx-auto w-full">
        <div className="px-3 sm:px-4 py-6 space-y-4">
          <header>
            <h1 className="text-2xl font-bold tracking-tight">Push</h1>
          </header>
          <div className="space-y-1 text-sm">
            <p className="text-text">Notifications: {permissionLabel}</p>
            <p className="text-text">This device: {deviceLabel}</p>
            {publicKey === null && <p className="text-text">VAPID public key: unset</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1">
              <button type="button" onClick={subscribe} disabled={busy || !supported || publicKey == null} className={primaryBtnCls}>
                Save this device&apos;s subscription
              </button>
              <Info call="push.saveSubscription({ subscription })" side="below">
                Records this browser&apos;s push subscription as a push-subscription event in Convex.
              </Info>
            </span>
            <span className="inline-flex items-center gap-1">
              <button type="button" onClick={test} disabled={busy || !endpoint} className={primaryBtnCls}>
                Send a test push to this device
              </button>
              <Info call="push.requestTest({ endpoint })" side="below">
                Schedules pushSend.sendToAll for this device&apos;s subscription only.
              </Info>
            </span>
          </div>
          {sent === true && <p className="text-success">sent</p>}
          <p className="min-h-5 text-xs text-error">{error}</p>
        </div>
      </div>
    </TomGate>
  );
}
