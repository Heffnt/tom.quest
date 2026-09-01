"use client";

import { useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useTuring } from "@/app/lib/hooks/use-turing";
import InteractiveTerminal from "@/app/turing/components/interactive-terminal";
import { VSCODE_TERMINAL_FONT } from "@/app/turing/lib/terminal-session";

interface SessionOutputResponse {
  output: string;
}

function ViewerTerminalPage({ sessionName }: { sessionName: string }) {
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
    <pre
      ref={viewerRef}
      className="flex-1 text-[#d4d4d4] font-mono text-[13px] leading-5 p-3 overflow-auto whitespace-pre-wrap break-words"
      style={{ fontFamily: VSCODE_TERMINAL_FONT }}
    >
      {sessionOutput.data?.output ?? (sessionOutput.error ? sessionOutput.error : "Fetching tmux session output…")}
    </pre>
  );
}

export default function TuringTerminalPage() {
  const params = useParams<{ session: string }>();
  const searchParams = useSearchParams();
  const rawSession = params.session;
  const sessionName = decodeURIComponent(Array.isArray(rawSession) ? rawSession[0] : rawSession ?? "");
  const interactive = searchParams.get("mode") === "interactive";

  return (
    <div className="fixed inset-0 bg-black flex flex-col" style={{ zIndex: 9999 }}>
      {interactive ? (
        <InteractiveTerminal
          sessionName={sessionName}
          surface="page"
          className="flex-1 overflow-hidden bg-black"
        />
      ) : (
        <ViewerTerminalPage sessionName={sessionName} />
      )}
    </div>
  );
}
