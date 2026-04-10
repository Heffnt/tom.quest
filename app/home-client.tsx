"use client";

import { useState } from "react";
import SymbolGame from "./components/symbol-game";
import Leaderboard from "./components/leaderboard";
import LoginModal from "./components/login-modal";

export default function HomeClient() {
  const [lastWinMs, setLastWinMs] = useState<number | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <>
      {/* Symbol Game — the hero */}
      <div className="animate-settle">
        <SymbolGame onWin={setLastWinMs} />
      </div>

      {/* Name and descriptor */}
      <div className="mt-10 text-center">
        <h1 className="text-4xl font-bold tracking-tight animate-settle-delay-1">
          Tom Heffernan
        </h1>
        <p className="mt-2 text-lg text-text-muted animate-settle-delay-2">
          PhD Student, AI @ WPI
        </p>
      </div>

      {/* Leaderboard */}
      <div className="mt-10 animate-settle-delay-3">
        <Leaderboard
          pendingScore={lastWinMs}
          onRequestLogin={() => setLoginOpen(true)}
        />
      </div>

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
    </>
  );
}
