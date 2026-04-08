"use client";

import type { ChannelsState } from "./useSSE";

interface Props {
  channels: ChannelsState;
}

const CHANNEL_NAMES = ["discord", "whatsapp"] as const;

export default function ChannelCards({ channels }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {CHANNEL_NAMES.map((name) => {
        const failing = channels.failing.includes(name);
        const ready = channels.ready && !failing;
        return (
          <div
            key={name}
            className="flex items-center gap-3 px-4 py-3 border border-white/10 rounded-lg bg-white/[0.02]"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                ready ? "bg-green-400" : "bg-red-400"
              }`}
            />
            <span className="text-sm capitalize">{name}</span>
            <span className="text-xs text-white/40 ml-auto">
              {ready ? "Connected" : "Disconnected"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
