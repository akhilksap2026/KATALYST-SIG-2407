---
name: Auth removal
description: Session-based login was fully removed from Catalyst.
---

## What was removed
- Frontend: `renderLogin()`, `_checkAuth()`, `_login()`, `_logout()`, auth state fields (`authUser`, `authChecked`, `loginU/P/Err/Busy`), Sign out button in topbar, login gate in `renderVals()`
- Backend: `express-session`, `connect-pg-simple`, `bcryptjs` middleware + routes (`/api/auth/login`, `/api/auth/logout`, `/api/auth/me`), `requireAuth` middleware, `ensureUsers()` bootstrap function
- Packages uninstalled: `express-session`, `bcryptjs`, `connect-pg-simple`
- Startup: Changed from `ensureUsers().then(() => app.listen())` to direct `app.listen()` with background seeds

## Why
User requested removal. App now loads directly to the dashboard. All API routes are open.

## Note
`SESSION_SECRET` secret still exists in Replit Secrets but is now unused. Safe to leave or delete.
`users` and `user_sessions` tables remain in the DB schema (schema.sql) — orphaned but harmless.
