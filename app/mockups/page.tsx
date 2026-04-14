import Link from "next/link";

const MOCKUPS = [
  {
    href: "/mockups/orbit",
    name: "Orbit",
    blurb: "Tools orbit a central star. Hover pauses the system and highlights a planet.",
  },
  {
    href: "/mockups/terminal",
    name: "Terminal",
    blurb: "CLI launcher. Type to filter, arrows to cycle, Enter to launch.",
  },
  {
    href: "/mockups/cards",
    name: "Cards",
    blurb: "A fanned hand of quest cards. Hover lifts a card and reveals its tool.",
  },
];

export default function MockupIndex() {
  return (
    <div className="min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center px-6 py-16">
      <h1 className="font-display text-3xl font-bold mb-2">Navigation Mockups</h1>
      <p className="text-text-muted mb-12">Three alternatives to the top bar.</p>

      <ul className="grid gap-4 w-full max-w-xl">
        {MOCKUPS.map((m) => (
          <li key={m.href}>
            <Link
              href={m.href}
              className="block p-5 rounded-lg border border-border hover:border-accent bg-surface/50 hover:bg-surface transition-colors"
            >
              <div className="font-display text-xl text-accent">{m.name}</div>
              <div className="mt-1 text-sm text-text-muted">{m.blurb}</div>
              <div className="mt-2 text-xs font-mono text-text-faint">{m.href}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
