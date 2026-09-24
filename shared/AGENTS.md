# shared

## what lives here

- Plain ESM modules that the Convex backend, the site and the Jarvis Box all import, and the session constants that used to be typed out once per side.
- Convex bundles these files into its default runtime and the box runs them with plain Node, which loads no TypeScript. So a module here imports no npm package, no `node:` builtin and no `.ts` file, and it reads no file.
- A module imports only its siblings, spelled `./name.mjs`.
- A table meant to keep its literal types carries `/** @type {const} */`, which TypeScript reads in place of `as const`.
- `package.json` lists every module under `exports`; `__tests__/package.test.mjs` fails when a module is missing from it or imports anything outside this directory.

## how the box reaches it

- The Jarvis repository installs this directory as the package `tom-quest-shared`, pinned to a tom.quest commit in its lockfile. A change here reaches the box when Jarvis bumps the pin.
