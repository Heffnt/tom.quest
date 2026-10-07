import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { execSync } from "node:child_process";

// The build the error pages name (app/lib/error-diagnosis.ts): Vercel sets
// VERCEL_GIT_COMMIT_SHA, VERCEL_GIT_COMMIT_REF and VERCEL_ENV at build time;
// a local or box build falls back to its git checkout.
function git(args: string): string {
  try {
    return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  env: {
    BUILD_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || git("rev-parse HEAD"),
    BUILD_BRANCH: process.env.VERCEL_GIT_COMMIT_REF || git("rev-parse --abbrev-ref HEAD"),
    BUILD_DEPLOY_ENV: process.env.VERCEL_ENV || "",
  },
  // pi-coding-agent ships native clipboard bindings (koffi) that Turbopack
  // cannot bundle into server chunks; load it at runtime instead.
  serverExternalPackages: ["@earendil-works/pi-coding-agent"],
  async redirects() {
    // "dts" -> "tts" rename (2026-08-29): links in already-sent Slack
    // digests point at the old path — query params are preserved by default.
    // "sessions" -> "runs" rename (2026-09-21), then "runs" -> "agents"
    // (2026-09-25): links in the record and in Slack still name /runs.
    // `:path*` matches zero segments too, so the rule also sends the bare
    // path to /agents. The page reads ?run= as it reads ?agent=, so an old
    // /runs?run=<id> link opens the same agent. /sessions is the sessions page
    // again (design section 5.1, 2026-10-06); it reads ?session=<id> as
    // /agents does, so an old /sessions?session=<id> link opens that session.
    // The /sessions redirect this replaced was permanent (308), but Vercel
    // served it with `cache-control: public, max-age=0, must-revalidate`
    // (curl -I https://www.tom.quest/sessions, 2026-10-06 23:35 Eastern), so a
    // browser that followed it holds a redirect that is stale at once and asks
    // the server again on the next visit, which now serves the page.
    // "tts" -> "jarvis" (2026-09-26, TTS dissolved into Jarvis): every
    // ?item=, ?tab= and ?intent= link already sent to Slack names /tts. The
    // observation page became the /agents window view the same night; its
    // links (the digest's box and failure lines) land on that view.
    return [
      { source: "/" + "dts", destination: "/jarvis", permanent: true },
      { source: "/tts", destination: "/jarvis", permanent: true },
      { source: "/observe", destination: "/agents?view=window", permanent: true },
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
