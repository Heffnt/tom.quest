"use client";

// The Jarvis thread, the one page Tom checks: the open items (api.thread.open)
// and the stream (api.thread.messages, api.thread.changes, api.dayLog.page,
// the #dump captures). api.thread.send does what a reply under each row does.

import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import { buildDays, type LogEntry } from "./feed";
import PushControl from "./push-control";
import ThreadView, { useHashId } from "./thread-view";

export default function ThreadClient() {
  const { isTom } = useAuth();
  const entries = useQuery(api.dayLog.page, isTom ? {} : "skip") as LogEntry[] | undefined;
  const todos = useQuery(api.tts.listTodos, isTom ? {} : "skip") as Doc<"todos">[] | undefined;
  const page = useQuery(api.thread.messages, isTom ? {} : "skip");
  const messages = page?.entries;
  const changePage = useQuery(api.thread.changes, isTom ? {} : "skip");
  const changes = changePage?.entries;
  const open = useQuery(api.thread.open, isTom ? {} : "skip");
  const send = useMutation(api.thread.send);
  const settle = useMutation(api.jarvis.intent.settle);
  const days = useMemo(
    () => buildDays(entries ?? [], todos ?? [], messages ?? [], changes ?? []),
    [changes, entries, messages, todos],
  );
  // A linked row the loaded stream lacks is read on its own.
  const hashId = useHashId();
  const inStream = useMemo(
    () => new Set(days.flatMap(([, rows]) => rows.flatMap((row) => [row.id, ...row.replies.map((one) => one.id)]))),
    [days],
  );
  const loaded = messages !== undefined && changes !== undefined;
  const linked = useQuery(api.thread.row, isTom && loaded && hashId !== null && !inStream.has(hashId) ? { id: hashId } : "skip");

  return (
    <TomGate label="Thread">
      <ThreadView
        days={days}
        open={open}
        loading={entries === undefined || todos === undefined || messages === undefined || changes === undefined}
        cuts={[...(page?.cuts ?? []), ...(changePage?.cuts ?? []), ...(open?.cuts ?? [])]}
        linked={linked}
        headerControl={<PushControl />}
        onSend={(text, subject) => send({ text, ...(subject === undefined ? {} : { subject: subject as Id<"events"> }) })}
        onAccept={(askId) => settle({ subject: `decision:${askId}`, verdict: "approve" })}
      />
    </TomGate>
  );
}
