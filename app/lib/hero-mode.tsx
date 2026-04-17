"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

export type HeroMode = "hero" | "docked";

interface HeroModeContextType {
  /** Effective mode: always "docked" off the home route; hero/docked on `/`. */
  mode: HeroMode;
  /** On `/`, switch to docked (game) state. No-op elsewhere. */
  startGame: () => void;
  /** On `/`, return to hero state. No-op elsewhere. */
  exitToHome: () => void;
}

const HeroModeContext = createContext<HeroModeContextType | undefined>(undefined);

export function HeroModeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isHome = pathname === "/";
  // Home-page mode intent: "hero" on arrival, "docked" once the user starts a game.
  const [homeMode, setHomeMode] = useState<HeroMode>("hero");

  // Route change to / resets to hero. Route change away has no effect on homeMode,
  // because off-home we surface "docked" directly.
  useEffect(() => {
    if (isHome) setHomeMode("hero");
  }, [isHome]);

  const startGame = useCallback(() => {
    setHomeMode("docked");
  }, []);

  const exitToHome = useCallback(() => {
    setHomeMode("hero");
  }, []);

  const mode: HeroMode = isHome ? homeMode : "docked";

  return (
    <HeroModeContext.Provider value={{ mode, startGame, exitToHome }}>
      {children}
    </HeroModeContext.Provider>
  );
}

export function useHeroMode() {
  const ctx = useContext(HeroModeContext);
  if (!ctx) throw new Error("useHeroMode must be used inside HeroModeProvider");
  return ctx;
}
