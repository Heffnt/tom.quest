import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // pi-coding-agent ships native clipboard bindings (koffi) that Turbopack
  // cannot bundle into server chunks; load it at runtime instead.
  serverExternalPackages: ["@earendil-works/pi-coding-agent"],
  async redirects() {
    // "dts" -> "tts" rename (2026-08-29): links in already-sent Slack
    // digests point at the old path — query params are preserved by default.
    // "sessions" -> "runs" rename (2026-09-21), then "runs" -> "agents"
    // (2026-09-25): the page lists every agent, not only sessions, and links
    // in the record and in Slack still name /sessions and /runs. `:path*`
    // matches zero segments too, so each rule also sends its bare path to
    // /agents. The page reads ?run= as it reads ?agent=, so an old
    // /runs?run=<id> link opens the same agent.
    // "tts" -> "jarvis" (2026-09-26, TTS dissolved into Jarvis): every
    // ?item=, ?tab= and ?intent= link already sent to Slack names /tts. The
    // observation page became the /agents window view the same night; its
    // links (the digest's box and failure lines) land on that view.
    return [
      { source: "/" + "dts", destination: "/jarvis", permanent: true },
      { source: "/tts", destination: "/jarvis", permanent: true },
      { source: "/observe", destination: "/agents?view=window", permanent: true },
      { source: "/sessions/:path*", destination: "/agents/:path*", permanent: true },
      { source: "/runs/:path*", destination: "/agents/:path*", permanent: true },
      // "vocabulary" -> "intent" (2026-09-26): the vocabulary is one view of
      // the intent page; the fragment names that view.
      { source: "/vocabulary", destination: "/intent#vocabulary", permanent: true },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "tomquest",

  project: "javascript-nextjs",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  }
});
