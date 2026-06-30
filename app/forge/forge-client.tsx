"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import BuilderForm from "./components/builder-form";
import JobList from "./components/job-list";
import ChatPanel from "./components/chat-panel";

export default function ForgeClient() {
  const { loading, isTom } = useAuth();
  const [chatJobId, setChatJobId] = useState<Id<"forgeJobs"> | null>(null);
  const jobs = useQuery(api.forge.listMine, isTom ? {} : "skip");

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-text-faint text-sm">Loading…</span>
      </div>
    );
  }

  if (!isTom) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="border border-border rounded-lg bg-surface/40 px-4 py-3 text-sm text-text-muted">
          Forge access is restricted to Tom.
        </div>
      </div>
    );
  }

  return (
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
  );
}
