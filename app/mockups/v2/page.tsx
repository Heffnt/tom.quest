import Link from "next/link";

const MOCKUPS = [
  {
    href: "/mockups/v2/classic",
    name: "Classic",
    blurb: "Ghost autocomplete + vertical list. Raycast/Spotlight minimal.",
  },
  {
    href: "/mockups/v2/grid",
    name: "Grid",
    blurb: "Dropdown is a 2–3 col card grid. Visual, mouse-friendly.",
  },
  {
    href: "/mockups/v2/preview",
    name: "Preview",
    blurb: "List on the left, preview pane on the right. Alfred-style.",
  },
];

export default function MockupV2Index() {
  return (
    <div className="min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center px-6 py-16">
      <h1 className="font-display text-3xl font-bold mb-2">Terminal Nav — v2</h1>
      <p className="text-text-muted mb-2">Refined terminal home with scroll-dock + dropdown.</p>
      <p className="text-text-faint text-sm mb-12 max-w-md text-center">
        Same core: logo + terminal, ghost autocomplete, scroll-dock, invalid routes land on <code className="text-accent">/mockups/v2/lost</code>.
        Only the dropdown presentation differs.
      </p>

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
