"use client";

// The header's push control, the /push page's subscribe path: it saves this
// browser's subscription (push.saveSubscription). Hidden without PushManager.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// A Convex error's refusal: the text after "Error: " up to the stack.
function refusal(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const match = /Uncaught Error: (.*?)(?:\n|\s+at |$)/.exec(text);
  return match ? match[1] : text;
}

export default function PushControl() {
  const [supported, setSupported] = useState(false);
  // Unknown (null) until this browser's lookup answers.
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publicKey = useQuery(api.push.vapidPublicKey, supported ? {} : "skip");
  const saveSubscription = useMutation(api.push.saveSubscription);

  useEffect(() => {
    const isSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setSupported(isSupported);
    if (!isSupported) return;
    navigator.serviceWorker
      .getRegistration("/")
      .then((registration) => registration?.pushManager.getSubscription() ?? null)
      .then((subscription) => setSubscribed(subscription !== null))
      .catch(() => setSubscribed(false));
  }, []);

  if (!supported) return null;

  const subscribe = async () => {
    setBusy(true);
    setError(null);
    try {
      const granted = await Notification.requestPermission();
      if (granted !== "granted") throw new Error("permission not granted");
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey!),
      });
      const json = subscription.toJSON();
      await saveSubscription({
        subscription: {
          endpoint: json.endpoint!,
          expirationTime: json.expirationTime ?? null,
          keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth },
        },
      });
      setSubscribed(true);
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void subscribe()}
        disabled={busy || subscribed !== false || publicKey == null}
        className="rounded-md border border-border px-2 py-1 text-xs text-text-muted transition-colors hover:bg-surface-alt hover:text-text disabled:opacity-60 disabled:hover:bg-transparent"
      >
        {subscribed === null ? "…" : subscribed ? "Subscribed" : (
          <>
            <span className="sm:hidden">Subscribe</span>
            <span className="hidden sm:inline">Subscribe this device</span>
          </>
        )}
      </button>
      {/* Absolute, so a refusal shifts nothing. */}
      {error !== null && (
        <p className="absolute right-0 top-full mt-1 whitespace-nowrap text-xs text-error">{error}</p>
      )}
    </div>
  );
}
