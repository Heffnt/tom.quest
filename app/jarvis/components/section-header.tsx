// A section's name and its count, the header each section at the top of the
// everything tab opens with.
export default function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="text-xs text-text-faint">
      {title} <span className="text-text-muted">{count}</span>
    </div>
  );
}
