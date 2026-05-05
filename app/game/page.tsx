import type { Metadata } from "next";
import GameClient from "./game-client";

export const metadata: Metadata = {
  title: "Game | tom.Quest",
  description: "A symbol-shooting mini-game for tom.Quest.",
};

export default function GamePage() {
  return <GameClient />;
}
