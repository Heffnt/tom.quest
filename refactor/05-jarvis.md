# Module 5: Jarvis Dashboard

## Overview

The Jarvis dashboard is already well-structured. This module is a light cleanup to wire it to the new auth and align with refactored patterns.

## Changes

### 1. Use `useAuth` from Module 2

Replace the current auth import in `app/jarvis/page.tsx`:

- Import `useAuth` from `@/app/lib/auth` instead of `@/app/components/AuthProvider`.
- The `isTom` check already comes from `useAuth()` — no logic change needed.

Apply the same import change to any sub-components in `app/jarvis/components/` that import from `AuthProvider`.

### 2. Simplify `/api/jarvis/config/route.ts`

- Replace `isTomUser` import from `@/app/lib/supabase` with `isTom` from `@/app/lib/turing` (or inline the check: `userId === process.env.NEXT_PUBLIC_TOM_USER_ID`).
- Remove any Supabase server client usage if the route only needs the Tom check.

### 3. Move files

Move `app/jarvis/` to `app/jarvis/` (it stays in place — it already has its own route). No structural changes.

### 4. Semantic HTML

Add `aria-label` attributes to the status indicator, session panels, and control buttons for agent navigability. This is a light pass, not a rewrite.

## Files Modified

- `app/jarvis/page.tsx` — update auth import
- `app/jarvis/components/*.tsx` — update auth imports if any reference `AuthProvider`
- `app/api/jarvis/config/route.ts` — simplify Tom check

## No New Files

## No New Dependencies

## Testing

### E2E tests (Playwright)

- Jarvis page loads without error
- Non-Tom user sees "view-only mode" message
- Connection status indicator renders (green dot or red dot)
