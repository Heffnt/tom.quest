"use client";

import Link from "next/link";
import { useState } from "react";

type Tool = {
  name: string;
  href: string;
  blurb: string;
  radius: number;   // px from center
  period: number;   // seconds per full orbit
  phase: number;    // degrees offset at t=0
  size: number;     // planet diameter in px
  color: string;    // tailwind bg-*
};

const TOOLS: Tool[] = [
  {
    name: "Turing",
    href: "/turing",
    blurb: "SLURM cluster monitor & GPU dashboard",
    radius: 180,
    period: 28,
    phase: 0,
    size: 56,
    color: "bg-accent",
  },
  {
    name: "Jarvis",
    href: "/jarvis",
    blurb: "Personal AI assistant & task runner",
    radius: 260,
    period: 42,
    phase: 140,
    size: 44,
    color: "bg-[#60a5fa]",
  },
];

export default function OrbitMockup() {
  const [hovered, setHovered] = useState<string | null>(null);
  const paused = hovered !== null;

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center overflow-hidden">
      <div className="relative w-[640px] h-[640px]">
        {/* Orbit rings */}
        {TOOLS.map((t) => (
          <div
            key={`ring-${t.name}`}
            className="absolute left-1/2 top-1/2 rounded-full border border-border/60"
            style={{
              width: t.radius * 2,
              height: t.radius * 2,
              transform: "translate(-50%, -50%)",
            }}
          />
        ))}

        {/* Central star */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
          <div className="w-20 h-20 rounded-full bg-accent/20 border border-accent flex items-center justify-center shadow-[0_0_60px_rgba(232,160,64,0.35)]">
            <span className="font-display font-bold text-2xl text-accent">t.q</span>
          </div>
          <div className="mt-4 text-sm text-text-muted">
            {hovered ?? "Tom Heffernan"}
          </div>
        </div>

        {/* Orbiting planets */}
        {TOOLS.map((t) => (
          <div
            key={t.name}
            className="absolute left-1/2 top-1/2"
            style={{
              width: t.radius * 2,
              height: t.radius * 2,
              transform: "translate(-50%, -50%)",
              animation: `orbit-spin ${t.period}s linear infinite`,
              animationDelay: `${-(t.phase / 360) * t.period}s`,
              animationPlayState: paused ? "paused" : "running",
            }}
          >
            <Link
              href={t.href}
              onMouseEnter={() => setHovered(t.name)}
              onMouseLeave={() => setHovered(null)}
              className="group absolute top-1/2 right-0 -translate-y-1/2 translate-x-1/2 flex flex-col items-center"
              style={{ animation: `orbit-counter ${t.period}s linear infinite`, animationPlayState: paused ? "paused" : "running" }}
            >
              <div
                className={`${t.color} rounded-full transition-all duration-200 group-hover:scale-125 group-hover:shadow-[0_0_30px_currentColor]`}
                style={{ width: t.size, height: t.size }}
              />
              <div className="mt-2 text-xs font-mono text-text-muted group-hover:text-text transition-colors">
                {t.name}
              </div>
              <div className="mt-1 text-[10px] text-text-faint max-w-[140px] text-center opacity-0 group-hover:opacity-100 transition-opacity">
                {t.blurb}
              </div>
            </Link>
          </div>
        ))}
      </div>

      <style jsx>{`
        @keyframes orbit-spin {
          from { transform: translate(-50%, -50%) rotate(0deg); }
          to   { transform: translate(-50%, -50%) rotate(360deg); }
        }
        @keyframes orbit-counter {
          from { transform: translate(50%, -50%) rotate(0deg); }
          to   { transform: translate(50%, -50%) rotate(-360deg); }
        }
      `}</style>
    </div>
  );
}
