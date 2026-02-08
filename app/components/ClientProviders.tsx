"use client";

import { ReactNode } from "react";
import { AuthProvider } from "./AuthProvider";
import FeedbackButton from "./FeedbackButton";

export default function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <FeedbackButton />
      {children}
    </AuthProvider>
  );
}
