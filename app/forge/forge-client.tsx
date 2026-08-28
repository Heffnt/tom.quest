"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import BuilderForm from "./components/builder-form";
import JobList from "./components/job-list";
import ChatPanel from "./components/chat-panel";

export default function ForgeClient() {
  // isTom still gates the query ("skip" idiom); TomGate owns the gate JSX.
  const { isTom } = useAuth();
  const [chatJobId, setChatJobId] = useState<Id<"forgeJobs"> | null>(null);
  const jobs = useQuery(api.forge.listMine, isTom ? {} : "skip");

  return (
    <TomGate label="Forge">
    <div className="max-w-6xl mx-auto px-6 py-10 space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Backdoor Forge</h1>
        <p className="text-text-muted mt-1">
          Build a boolean-trigger backdoor, train it on the Turing cluster, then chat with the
          result. Part of tom.Quest.
        </p>
      </header>

      <BuilderForm />

      <JobList jobs={jobs} onOpenChat={(id) => setChatJobId(id)} activeChatJobId={chatJobId} />

      {chatJobId && (
        <ChatPanel jobId={chatJobId} onClose={() => setChatJobId(null)} />
      )}
    </div>
    </TomGate>
  );
}
