# shared

## what lives here

- Plain ESM modules that the Convex backend, the site and the Jarvis Box all import, and the session constants that used to be typed out once per side.
- Convex bundles these files into its default runtime and the box runs them with plain Node, which loads no TypeScript. So a module here imports no npm package, no `node:` builtin and no `.ts` file, and it reads no file.
- A module imports only its siblings, spelled `./name.mjs`.
- A table meant to keep its literal types carries `/** @type {const} */`, which TypeScript reads in place of `as const`.
- `package.json` lists every module under `exports`; `__tests__/package.test.mjs` fails when a module is missing from it or imports anything outside this directory.

## how the box reaches it

- `worker/setup.sh` copies `shared/*.mjs` to `/opt/tts/shared/`, which the installed `scripts/` import.
- Box code under `worker/` keeps its old import paths. Each moved module left a symlink at its old path, `cp` follows it, and `scripts/check-session-mirrors.mjs` checks every link's target.
