"use client";

import RunContextViewer from "./RunContextViewer";
import WorkspaceFileTab from "./WorkspaceFileTab";

export default function ContextTab({ selectedSessionKey }: { selectedSessionKey: string }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">Context</h2>
        <p className="text-xs text-white/35 mt-1">
          Session-specific injected context stays synced with whatever session you selected on Home.
        </p>
      </div>
      <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/5 text-xs text-white/45 uppercase tracking-wider">
          Selected Session Context
        </div>
        <RunContextViewer sessionKey={selectedSessionKey} />
      </div>
      <WorkspaceFileTab
        title="Pinned Default Context Files"
        description="Raw workspace context files that shape Jarvis by default."
        prefix=""
        initialPath="SOUL.md"
      />
    </section>
  );
}
