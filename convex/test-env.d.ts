// Vitest runs on Vite, which provides `import.meta.glob` at runtime; convex-test
// uses it to load the Convex function modules (see convex/*.test.ts).
//
// We declare the type here rather than `/// <reference types="vite/client" />`
// because `vite` is a transitive dependency that pnpm does not hoist to the
// project's top-level node_modules. The reference only resolves locally — TS
// walks up into the parent checkout's node_modules from inside a git worktree —
// and fails in CI's standalone checkout (TS2688), which in turn leaves
// `import.meta.glob` untyped (TS2339). This ambient declaration is environment
// independent.
//
// The return type is assignable to convex-test's `modules` param
// (`Record<string, () => Promise<any>>`).
interface ImportMeta {
  glob(
    patterns: string | string[],
    options?: { eager?: boolean },
  ): Record<string, () => Promise<Record<string, unknown>>>;
}
