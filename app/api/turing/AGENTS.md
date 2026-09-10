# app/api/turing

- `[...path]/route.ts` forwards to `TURING_API_URL` through `forwardToTuringApi` with the `X-API-Key` header; the key never leaves Vercel.
- A non-JSON upstream body becomes a JSON error.
- GET admits `agent` through `requireAdminOrAgent`; every other method and `ws-credentials` call `requireAdmin`.
- The cluster side is `turing-api/AGENTS.md`.
