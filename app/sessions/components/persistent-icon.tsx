// The icon of each persistent session (design section 4.1), by the session's
// name. The five names are the whole set; any other title draws no icon.

const PATHS: Record<string, React.ReactNode> = {
  // dump: a tray things are dropped into
  dump: (
    <>
      <path d="M3 13h4l1.5 2h3L13 13h4" />
      <path d="M3 13l2-8h10l2 8v3H3z" />
    </>
  ),
  // briefer: a page of lines
  briefer: (
    <>
      <path d="M5 3h7l3 3v11H5z" />
      <path d="M8 9h5M8 12h5M8 15h3" />
    </>
  ),
  // builder: a hammer
  builder: (
    <>
      <path d="M4 16l7-7" />
      <path d="M9 5l3-2 5 5-2 3z" />
    </>
  ),
  // observer: an eye
  observer: (
    <>
      <path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z" />
      <circle cx="10" cy="10" r="2.2" />
    </>
  ),
  // todo: a checked box
  todo: (
    <>
      <rect x="3.5" y="3.5" width="13" height="13" rx="2" />
      <path d="M7 10l2 2 4-4.5" />
    </>
  ),
};

export default function PersistentIcon({ name }: { name: string }) {
  const key = name.trim().toLowerCase();
  const path = PATHS[key];
  if (path === undefined) return null;
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon={key}
      className="shrink-0"
    >
      {path}
    </svg>
  );
}
