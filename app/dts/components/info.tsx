// The ⓘ bubble every mono mutation caption on /dts sits behind. label is the
// exact backend call the neighboring control fires (UI = code); it shows only
// on hover/focus, in a floating tooltip — it never enters the page flow.

export default function Info({ label }: { label: string }) {
  return (
    <span className="relative inline-flex items-baseline group">
      <button
        type="button"
        tabIndex={0}
        className="text-[10px] text-text-faint hover:text-text-muted"
      >
        ⓘ
      </button>
      <span className="hidden group-hover:block group-focus-within:block absolute bottom-full left-1/2 -translate-x-1/2 mb-1 font-mono text-[10px] bg-surface-alt text-text-muted border border-border rounded px-1.5 py-0.5 whitespace-nowrap z-30 shadow">
        {label}
      </span>
    </span>
  );
}
