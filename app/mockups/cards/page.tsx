"use client";

import Link from "next/link";
import { useState } from "react";

type Card = {
  name: string;
  href: string;
  glyph: string;
  tagline: string;
  blurb: string;
};

const CARDS: Card[] = [
  {
    name: "Turing",
    href: "/turing",
    glyph: "⌬",
    tagline: "The Cluster",
    blurb: "SLURM queue, GPU utilization, live job status.",
  },
  {
    name: "Jarvis",
    href: "/jarvis",
    glyph: "◈",
    tagline: "The Assistant",
    blurb: "Personal AI agent for tasks, notes, and lookups.",
  },
];

const FAN_SPREAD = 18; // degrees between cards
const HOVER_LIFT = 48;

export default function CardsMockup() {
  const [hovered, setHovered] = useState<number | null>(null);
  const count = CARDS.length;
  const mid = (count - 1) / 2;

  return (
    <div className="min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center px-6">
      <div className="text-center mb-16">
        <h1 className="font-display text-4xl font-bold">Tom Heffernan</h1>
        <p className="mt-2 text-text-muted">Choose your quest.</p>
      </div>

      {/* Card fan */}
      <div
        className="relative flex items-end justify-center"
        style={{ width: 520, height: 360 }}
        onMouseLeave={() => setHovered(null)}
      >
        {CARDS.map((c, i) => {
          const offset = i - mid;
          const rot = offset * FAN_SPREAD;
          const tx = offset * 90;
          const isHover = hovered === i;
          const dim = hovered !== null && !isHover;

          return (
            <Link
              key={c.name}
              href={c.href}
              onMouseEnter={() => setHovered(i)}
              className="absolute bottom-0 left-1/2 group"
              style={{
                transformOrigin: "bottom center",
                transform: isHover
                  ? `translate(-50%, -${HOVER_LIFT}px) rotate(0deg) scale(1.08)`
                  : `translate(calc(-50% + ${tx}px), 0) rotate(${rot}deg)`,
                transition: "transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms",
                opacity: dim ? 0.45 : 1,
                zIndex: isHover ? 10 : i,
              }}
            >
              <div
                className={`w-52 h-80 rounded-xl border bg-gradient-to-b from-surface to-surface-alt shadow-2xl flex flex-col items-center justify-between p-6 ${
                  isHover ? "border-accent shadow-[0_0_60px_rgba(232,160,64,0.25)]" : "border-border"
                }`}
              >
                <div className="text-xs font-mono text-text-faint uppercase tracking-widest">
                  {c.tagline}
                </div>

                <div
                  className={`text-7xl font-display transition-colors ${
                    isHover ? "text-accent" : "text-text-muted"
                  }`}
                >
                  {c.glyph}
                </div>

                <div className="text-center">
                  <div className="font-display text-xl font-bold">{c.name}</div>
                  <div
                    className={`mt-2 text-xs text-text-muted transition-opacity ${
                      isHover ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    {c.blurb}
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      <p className="mt-12 text-xs text-text-faint">hover a card to reveal · click to enter</p>
    </div>
  );
}
