export default function Help() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="text-4xl font-bold tracking-tight animate-settle">Help</h1>
      <p className="mt-2 text-lg text-text-muted animate-settle-delay-1">
        How to get around tom.quest.
      </p>

      <section aria-label="Nav terminal" className="mt-12 animate-settle-delay-1">
        <h2 className="text-2xl font-semibold mb-4">Nav terminal</h2>
        <p className="text-text/80 leading-relaxed">
          The bar at the top is a tiny terminal. Start typing any page name and
          matches appear below. Use the keys on the left, click a row on the
          right, or hit the amber <span className="font-mono">show pages</span>{" "}
          button to browse everything.
        </p>
        <ul className="list-disc list-inside text-text/80 space-y-2 mt-4 font-mono text-sm">
          <li><span className="text-accent">Enter</span> — go to the highlighted page (or whatever you typed)</li>
          <li><span className="text-accent">Tab</span> — autocomplete to the best match</li>
          <li><span className="text-accent">↑ / ↓</span> — move the highlight</li>
          <li><span className="text-accent">Esc</span> — close the list</li>
        </ul>
      </section>

      <section aria-label="The game" className="mt-12 animate-settle-delay-2">
        <h2 className="text-2xl font-semibold mb-4">The game</h2>
        <p className="text-text/80 leading-relaxed">
          On the home page, click the <span className="font-mono">tom.Quest</span>{" "}
          logo or press <span className="font-mono">space</span> to start. A bar
          spins inside a circle; fire an arrow by pressing space or tapping so
          it lands on one of the three angle targets. Each hit speeds up the
          spin and flips the direction. Miss all three targets and you fail —
          your streak goes on the leaderboard. Click the logo again to return
          to the start screen.
        </p>
      </section>

      <section aria-label="Accounts" className="mt-12 animate-settle-delay-2">
        <h2 className="text-2xl font-semibold mb-4">Accounts</h2>
        <p className="text-text/80 leading-relaxed">
          Signing in (top-right) lets you save scores to the leaderboard and
          pick a display name. It is optional — you can play as much as you
          want without an account.
        </p>
      </section>
    </div>
  );
}
