"use client";

import dynamic from "next/dynamic";

// Three.js touches browser globals at module load (window/document), so the
// viewer must be client-only. dynamic({ ssr: false }) skips the SSR pass
// for this subtree; this requires a client wrapper, hence "use client" above.
const CloudsClient = dynamic(() => import("./clouds-client"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[calc(100vh-4rem)] flex items-center justify-center">
      <div className="text-text-muted text-sm font-mono">loading viewer…</div>
    </div>
  ),
});

export default function CloudsPage() {
  return <CloudsClient />;
}
