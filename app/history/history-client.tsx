"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import { newYorkDay } from "@/shared/clock.mjs";
import HistoryView, { type Range } from "./history-view";
import { presetRange } from "./lib";

const SURFACE = "History";

export default function HistoryClient() {
  const { canReadSurface } = useAuth();
  const [today] = useState(() => newYorkDay(Date.now()));
  const [range, setRange] = useState<Range>(() => presetRange(today, 28));
  const data = useQuery(api.history.page, canReadSurface(SURFACE) ? range : "skip");
  return (
    <TomGate label={SURFACE}>
      <HistoryView data={data} range={range} today={today} onRange={setRange} />
    </TomGate>
  );
}
