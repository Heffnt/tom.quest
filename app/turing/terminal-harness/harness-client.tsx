"use client";

// Client half of the terminal-modal test fixture. See page.tsx for why this
// route exists. It renders the real TerminalModal with the real props the jobs
// table passes it, so the modal surface under test is the shipped component.

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import TerminalModal from "@/app/turing/components/terminal-modal";

function Harness() {
  const searchParams = useSearchParams();
  const sessionName = searchParams.get("session") ?? "";
  if (!sessionName) return <p>Add ?session=&lt;tmux session name&gt; to this URL.</p>;
  return (
    <TerminalModal
      sessionName={sessionName}
      allSessions={[sessionName]}
      onClose={() => {}}
      onNavigate={() => {}}
      allowInteractive
    />
  );
}

export default function TerminalHarnessClient() {
  return (
    <Suspense fallback={null}>
      <Harness />
    </Suspense>
  );
}
