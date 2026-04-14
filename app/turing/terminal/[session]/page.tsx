"use client";

import { useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { useTuring } from "@/app/lib/hooks/use-turing";

interface SessionOutputResponse {
  output: string;
}

const VSCODE_TERMINAL_FONT = 'Consolas, "Courier New", monospace';

export default function TuringTerminalPage() {
  const params = useParams<{ session: string }>();
  const rawSession = params.session;
  const sessionName = decodeURIComponent(Array.isArray(rawSession) ? rawSession[0] : rawSession ?? "");
  const viewerRef = useRef<HTMLPreElement>(null);
  const viewerScrolledRef = useRef(false);
  const sessionOutput = useTuring<SessionOutputResponse>(
    `/sessions/${encodeURIComponent(sessionName)}/output`,
    { refreshInterval: 2 },
  );

  useEffect(() => {
    const output = sessionOutput.data?.output;
    if (output === undefined || viewerScrolledRef.current) return;
    requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      viewer.scrollTop = viewer.scrollHeight;
      viewerScrolledRef.current = true;
    });
  }, [sessionOutput.data?.output]);

  return (
    <div className="fixed inset-0 bg-black flex flex-col" style={{ zIndex: 9999 }}>
      <pre
        ref={viewerRef}
        className="flex-1 text-[#d4d4d4] font-mono text-[13px] leading-5 p-3 overflow-auto whitespace-pre-wrap break-words"
        style={{ fontFamily: VSCODE_TERMINAL_FONT }}
      >
        {sessionOutput.data?.output ?? (sessionOutput.error ? sessionOutput.error : "Loading session output…")}
      </pre>
    </div>
  );
}
