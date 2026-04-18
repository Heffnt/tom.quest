"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import SymbolGame from "./components/symbol-game";
import Leaderboard, { type PendingResult } from "./components/leaderboard";
import LoginModal from "./components/login-modal";
import TomSymbol, { TOM_SYMBOL_VB } from "./components/tom-symbol";
import { useHeroMode } from "./lib/hero-mode";

/* Game size reserves room for the docked nav at the top and for score + retry
   text + leaderboard area below. Clamped to a reasonable max so it doesn't
   dominate on huge displays. */
function computeGameSize(vw: number, vh: number): number {
  const topReserve = 80;      // docked nav + gutter
  const bottomReserve = 220;  // score label + retry hint + leaderboard header
  const maxByHeight = vh - topReserve - bottomReserve;
  const maxByWidth = vw * 0.82;
  return Math.max(260, Math.min(maxByWidth, maxByHeight, 440));
}

function useViewportSize() {
  const [size, setSize] = useState({ w: 1024, h: 768 });
  useEffect(() => {
    const measure = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return size;
}

/* Shared-element transition: when the user starts a game, the tom symbol from
   the hero logo appears to "grow into" the game canvas. A fixed-position SVG
   ghost starts at the hero symbol's rect and transitions to the game canvas
   rect; the canvas itself fades in at the same time. The nav logo's own
   hero→docked transform runs in parallel — both share the DOCK_MS timing. */
type Ghost = {
  phase: "pending" | "active" | "done";
  from: { x: number; y: number; w: number; h: number };
  to:   { x: number; y: number; w: number; h: number };
};

const DOCK_MS = 420;
const GHOST_EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const SYMBOL_AR = TOM_SYMBOL_VB.w / TOM_SYMBOL_VB.h;

function fitToRect(container: DOMRect): { x: number; y: number; w: number; h: number } {
  /* The game canvas is square; the symbol is wider than tall (aspect ≈ 1.3).
     Scale the symbol to fit the canvas rect while preserving aspect, then
     center it — the same fit the game itself uses for its render geometry. */
  const ar = SYMBOL_AR;
  let w = container.width;
  let h = w / ar;
  if (h > container.height) {
    h = container.height;
    w = h * ar;
  }
  return {
    x: container.left + (container.width - w) / 2,
    y: container.top + (container.height - h) / 2,
    w,
    h,
  };
}

function rectFromSvg(el: SVGSVGElement): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

export default function HomeClient() {
  const { mode, startGame } = useHeroMode();
  const [result, setResult] = useState<PendingResult | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const nextWinId = useRef(1);
  const { w, h } = useViewportSize();
  const gameSize = computeGameSize(w, h);

  const prevModeRef = useRef(mode);
  const heroRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  /* Keep a fresh snapshot of the hero symbol's rect while in hero mode, so we
     can use it as the ghost's starting frame the moment the user starts the
     game. Reading it at transition time would race the nav's CSS transform. */
  useLayoutEffect(() => {
    if (mode !== "hero") return;
    const measure = () => {
      const el = document.querySelector<SVGSVGElement>("[data-tom-symbol]");
      if (!el) return;
      heroRectRef.current = rectFromSvg(el);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [mode, w, h]);

  /* When mode flips hero→docked (game start), kick off the ghost transition.
     `pending` frame paints the ghost at the hero rect; the next frame flips
     it to the target rect to trigger the CSS transition. `done` cleans up. */
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if (!(prev === "hero" && mode === "docked")) return;
    const heroRect = heroRectRef.current;
    if (!heroRect) return;

    // The game canvas is about to mount — measure on the next layout pass.
    const id = requestAnimationFrame(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("[data-game-canvas]");
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const to = fitToRect(rect);
      setGhost({ phase: "pending", from: heroRect, to });

      // Kick the transition one frame after mount.
      const id2 = requestAnimationFrame(() => {
        setGhost((g) => (g ? { ...g, phase: "active" } : g));
      });
      // Tear down after the transition completes.
      const id3 = window.setTimeout(() => {
        setGhost((g) => (g ? { ...g, phase: "done" } : g));
      }, DOCK_MS + 40);
      return () => {
        cancelAnimationFrame(id2);
        window.clearTimeout(id3);
      };
    });
    return () => cancelAnimationFrame(id);
  }, [mode]);

  // Hero mode: space key starts the game (click-on-logo is handled in QuestNav).
  useEffect(() => {
    if (mode !== "hero") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;
      e.preventDefault();
      startGame();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, startGame]);

  // Going back to hero (logo click) clears any fail result and ghost.
  useEffect(() => {
    if (mode === "hero") {
      setResult(null);
      setGhost(null);
    }
  }, [mode]);

  // Hero mode: the QuestNav renders the big logo, hint, and expanded nav term.
  // Nothing in the main content area — just the login modal mount.
  if (mode === "hero") {
    return <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />;
  }

  /* While the ghost runs, hide the canvas so the ghost is the only visible
     symbol. Crossfade in at the end (canvas opacity goes 0 → 1 as ghost
     completes, matching the transition duration). */
  const canvasHidden = ghost !== null && ghost.phase !== "done";
  const gameOpacity = canvasHidden ? 0 : 1;

  return (
    <div className="flex flex-col items-center w-full">
      <div
        style={{
          opacity: gameOpacity,
          transition: `opacity ${Math.floor(DOCK_MS * 0.5)}ms ${GHOST_EASE}`,
        }}
      >
        <SymbolGame
          size={gameSize}
          onResult={({ hits }) => setResult({ winId: nextWinId.current++, ms: hits })}
          onReset={() => setResult(null)}
        />
      </div>

      {result !== null && (
        <div className="mt-10 w-full flex justify-center">
          <Leaderboard
            result={result}
            onRequestLogin={() => setLoginOpen(true)}
          />
        </div>
      )}

      {ghost && ghost.phase !== "done" && (
        <GhostSymbol ghost={ghost} />
      )}

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
    </div>
  );
}

function GhostSymbol({ ghost }: { ghost: Ghost }) {
  const r = ghost.phase === "pending" ? ghost.from : ghost.to;
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${TOM_SYMBOL_VB.w} ${TOM_SYMBOL_VB.h}`}
      style={{
        position: "fixed",
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        color: "var(--color-accent)",
        pointerEvents: "none",
        zIndex: 30,
        overflow: "visible",
        transition: `left ${DOCK_MS}ms ${GHOST_EASE}, top ${DOCK_MS}ms ${GHOST_EASE}, width ${DOCK_MS}ms ${GHOST_EASE}, height ${DOCK_MS}ms ${GHOST_EASE}`,
        willChange: "left, top, width, height",
      }}
    >
      <TomSymbol />
    </svg>
  );
}
