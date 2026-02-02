"use client";

import { ReactNode } from "react";
import { AuthProvider } from "./AuthProvider";
import DeviceTracker from "./DeviceTracker";
import ChatBubble from "./ChatBubble";

export default function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <DeviceTracker />
      <ChatBubble />
      {children}
    </AuthProvider>
  );
}
