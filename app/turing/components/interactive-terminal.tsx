"use client";

// The only React component that renders an interactive Turing terminal. Both
// the modal over the jobs table and the full-page terminal render this, so the
// credential fetch, reconnect limit, font and open/size/resize/reconnect
// sequence exist once, in app/turing/lib/terminal-session.ts.

import { useEffect, useRef } from "react";
import { useAuth } from "@/app/lib/auth";
import {
  startTerminalSession,
  type TerminalConnectionStatus,
  type TerminalSurface,
} from "@/app/turing/lib/terminal-session";

interface InteractiveTerminalProps {
  sessionName: string;
  /** Labels debug lines so modal and page sessions stay distinguishable. */
  surface: TerminalSurface;
  className?: string;
  onStatusChange?: (status: TerminalConnectionStatus) => void;
}

export default function InteractiveTerminal({
  sessionName,
  surface,
  className,
  onStatusChange,
}: InteractiveTerminalProps) {
  const { token } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  // Held in a ref so a caller passing an inline callback does not tear down and
  // reopen the terminal on every render.
  const statusHandlerRef = useRef(onStatusChange);
  statusHandlerRef.current = onStatusChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return startTerminalSession({
      container,
      sessionName,
      token,
      surface,
      onStatusChange: (status) => statusHandlerRef.current?.(status),
    });
  }, [sessionName, surface, token]);

  return <div ref={containerRef} className={className} />;
}
