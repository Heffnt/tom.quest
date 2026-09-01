"use client";

// The ground-up explanation, fullscreen. Agents author each explanation as a
// complete self-contained HTML document (their proven medium for making Tom
// understand); it renders in a sandboxed iframe filling the screen. Legacy
// plain-text explanations render as simple paragraphs until a worker
// re-authors them.
export default function GroundUpView({
  title,
  content,
  onClose,
}: {
  title: string;
  content: string;
  onClose: () => void;
}) {
  const isHtml = content.trimStart().startsWith("<");
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-bg">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="truncate text-sm text-text">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1 text-[13px] text-text-muted hover:border-text-faint hover:text-text"
        >
          close
        </button>
      </div>
      {isHtml ? (
        <iframe
          sandbox=""
          srcDoc={content}
          title={title}
          className="h-full w-full flex-1 border-0 bg-bg"
        />
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            {content.split(/\n{2,}|(?<=\.)\s+(?=[A-Z])/).map((p, i) => (
              <p key={i} className="text-[14px] leading-relaxed text-text-muted">
                {p}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
