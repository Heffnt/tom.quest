# Turing API Route

## Turing Proxy

- Next.js API routes (`app/api/turing/[...path]/route.ts`) read `TURING_API_URL` from env and forward requests through `forwardToTuringApi`, attaching the `X-API-Key` header. The shared key never leaves Vercel.
- The proxy detects HTML/non-JSON upstream responses and converts them to structured JSON errors.
- See `turing-api/AGENTS.md` for the cluster API contract and operating constraints.
