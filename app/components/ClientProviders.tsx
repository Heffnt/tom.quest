"use client";

import { ReactNode } from "react";
import { AuthProvider } from "./AuthProvider";
import FeedbackButton from "./FeedbackButton";
import DebugPanel from "./DebugPanel";

export default function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <FeedbackButton />
      {children}
      <DebugPanel />
    </AuthProvider>
  );
}
