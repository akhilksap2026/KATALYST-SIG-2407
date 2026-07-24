---
name: Admin screen design
description: Architecture and data model for the Admin screen (id:'admin', T1) added to Catalyst.
---

## Structure

5 tabs rendered by dedicated `_renderAdminXxx()` methods, all called from `renderAdmin()`.
Admin data is **lazy-loaded** on first render via `_loadAdminData()` — not fetched at startup.
State flag `adminLoaded` guards the load so it only runs once.

## DB Tables (all seeded by `autoSeedAdminIfEmpty()` on first boot)

| Table | Purpose |
|---|---|
| `admin_roles` | 5 roles; permissions stored as JSONB `{resource:{action:bool}}` |
| `admin_users` | 8 users with role_id FK and sso_provider |
| `sso_connections` | 3 IdP connections (oracle_idcs, azure_ad, google_ws); `attribute_map` JSONB |
| `api_keys` | key stored as SHA-256 hash; prefix shown in UI; `scopes TEXT[]` |
| `global_config` | 12 settings; separate `dev_value/test_value/prod_value` columns |

## API Endpoints (all under `/api/admin/`)

- `GET/PUT /roles`, `PUT /roles/:id/permissions`
- `GET /users`, `PUT /users/:id`
- `GET/PUT /sso/:id`, `POST /sso/:id/test`
- `GET /api-keys`, `POST /api-keys`, `DELETE /api-keys/:id`, `PUT /api-keys/:id/rotate`
- `GET /global-config`, `PUT /global-config/:key`, `POST /global-config/propagate`

## Key design decisions

- **RBAC matrix**: permissions edited optimistically in `this.adminRoles` array, saved explicitly with "Save permissions" button calling `PUT /roles/:id/permissions`.
- **API key generation**: raw key shown once in UI after POST; only `key_prefix` and SHA-256 `key_hash` persisted.
- **Global config propagate**: modal with per-environment checkboxes + explicit confirmation before calling `POST /global-config/propagate`; never silent broadcast.
- **SSO toggle**: enable/disable via inline toggle that calls `PUT /sso/:id` immediately.
- **Admin audit tab**: filters applied client-side on `this.audit` (same data as the main Audit Log screen), not a separate endpoint.

**Why:** Lazy loading keeps startup fast; admin is rarely visited. Propagate confirmation matches the "nothing is destructive" principle.
