"use client";

import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type DiagnosticEvent = {
  level: "error" | "warn";
  message: string;
  timestamp: number;
};

interface DiagnosticsStore {
  events: DiagnosticEvent[];
  capture: (event: DiagnosticEvent) => void;
  clear: () => void;
}

const MAX_EVENTS = 10;

export const useDiagnosticsStore = create<DiagnosticsStore>()(
  devtools(
    (set) => ({
      events: [],
      capture: (event) =>
        set((state) => ({
          events: [...state.events, event].slice(-MAX_EVENTS),
        })),
      clear: () => set({ events: [] }),
    }),
    { name: "tom.quest diagnostics" },
  ),
);

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

let installed = false;

export function installConsoleDiagnostics() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    useDiagnosticsStore.getState().capture({
      level: "error",
      message: formatConsoleArgs(args),
      timestamp: Date.now(),
    });
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    useDiagnosticsStore.getState().capture({
      level: "warn",
      message: formatConsoleArgs(args),
      timestamp: Date.now(),
    });
    originalWarn(...args);
  };
}
