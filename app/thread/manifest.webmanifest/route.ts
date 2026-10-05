// The thread's web app manifest: a home-screen bookmark of /thread opens the
// thread, standalone. The site manifest (app/manifest.ts) is unchanged.
export function GET() {
  return Response.json(
    {
      name: "Jarvis thread",
      short_name: "Jarvis",
      start_url: "/thread",
      display: "standalone",
      background_color: "#0a0e17",
      theme_color: "#0a0e17",
      icons: [
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        { src: "/apple-icon", sizes: "180x180", type: "image/png" },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json" } },
  );
}
