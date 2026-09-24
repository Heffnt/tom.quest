// Page — the frame every Jarvis page sits in: under the real tom.Quest header
// (AppShell pads for it), a 24 px gutter, at most 1280 px wide. It is also the
// toolbox's root: the one font family and the type scale start here. The file
// is not page.tsx because under app/ that name is a route of its own.

import type { ReactNode } from "react";

export default function Page({ children }: { children: ReactNode }) {
  return <div className="tb-root tb-page">{children}</div>;
}
