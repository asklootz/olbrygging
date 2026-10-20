# olbrygging

A Norwegian-language ambassador CRM for Ølbrygging AS, with Supabase-backed and standalone local demo modes:

- An illustrated, searchable product catalogue with category filters.
- Promotion requests with product, idea, channel, and publication date.
- Ambassador-specific collaboration lists and progress tracking.
- Employee review, approval, assignment, deadlines, and completion.
- Persistent ticket conversations, email drafts, and optional outbound email notifications.
- Supabase Auth, PostgreSQL persistence, and database-enforced role and ticket access checks.
- A dependency-free local demo with password authentication and JSON storage.
- Responsive desktop/mobile layouts and keyboard-accessible dialogs.

## Run

Requires **Node.js 22 or newer**. No packages or build step are needed. Without Supabase configuration, the application runs the local demo:

```sh
npm start
```

Open **http://127.0.0.1:3000**. Use the demo-role buttons or log in with:

| Role | Email | Password |
| --- | --- | --- |
| Ambassador | `ambassador@olbrygging.example` | `BrewTogether!2026` |
| Employee | `employee@olbrygging.example` | `BrewTogether!2026` |
| Second ambassador | `sara@olbrygging.example` | `BrewTogether!2026` |
| Second employee | `marius@olbrygging.example` | `BrewTogether!2026` |

These are public **demo credentials**, not real accounts. All products, prices, people, and conversations are fictional examples, not a live olbrygging.no integration.

### Try the workflow

1. Log in as an ambassador, select a product, and submit a promotion idea.
2. Log out and log in as an employee. Open the request, select a contact person, and approve it.
3. As the ambassador, move the approved collaboration to **Pågår**, exchange messages with the contact person, and submit it **Til gjennomgang**.
4. The employee can complete the collaboration or return it for further work.

The workspace refreshes conversations periodically while open. Messages and ticket changes persist across restarts.

## Storage and configuration

In local demo mode, the first launch seeds `data/workspace.json`. Writes are atomic; the data folder is ignored by Git. Stop the server and delete this file to reset the demo. Back it up to preserve changes. Demo sessions are held in memory and expire after 12 hours or a server restart.

When Supabase is configured, no local workspace or demo accounts are created or read. Database/authentication failures never fall back to the demo.

| Variable | Default / purpose |
| --- | --- |
| `HOST` | `127.0.0.1` — local access only |
| `PORT` | `3000` |
| `DATA_FILE` | `data/workspace.json` |
| `SUPABASE_URL` | Supabase project URL; HTTPS required except for localhost |
| `SUPABASE_PUBLISHABLE_KEY` | Project publishable key; enables Supabase mode together with the URL |
| `SUPABASE_ANON_KEY` | Legacy anon JWT alternative to the publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional **server-only** service role/secret key, solely for recording email delivery outcomes |
| `RESEND_API_KEY` | Optional outbound email provider key |
| `EMAIL_FROM` | Verified sender address for Resend |
| `COOKIE_SECURE` | Set to `true` only when serving through HTTPS |
| `NODE_ENV` | `production` refuses startup without Supabase and `COOKIE_SECURE=true` |

### Supabase setup

1. Create a Supabase project. Apply `supabase/migrations/20261020000000_portal.sql` using the project's SQL Editor (or `psql` with an administrator database connection). The migration creates profiles, products, tickets, messages, indexes, RLS policies, and transactional RPCs. It seeds only the eight fictional catalogue products, not users or conversations. Replace the catalogue through trusted database administration before real use.
2. In **Authentication → Providers → Email**, enable email/password authentication and disable new-user signups for an invite-only workspace. Create accounts with an initial password using **Authentication → Users → Add user → Create new user**. Existing Auth users are also given profiles by the migration. Profiles default to `ambassador`; user metadata cannot grant employee access.
3. Assign employees through trusted SQL administration, using their Auth user UUID:

   ```sql
   update public.profiles set role = 'employee' where id = '<auth-user-uuid>';
   ```

   Create at least one employee before submitting requests. Names come from Auth user metadata `name` (falling back to email); email changes are synchronized from Auth. Do not grant clients profile-write permissions.
4. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` from the project's API settings. A legacy anon key is also supported. Do not put a service role/secret key in the publishable/anon setting. Start with:

   ```sh
   node --env-file=.env server.mjs
   ```

   `npm start` also works when environment variables are already exported; it does not load `.env` automatically.
5. For deployment, use HTTPS, set `COOKIE_SECURE=true` and `NODE_ENV=production`, and configure `HOST` for your hosting environment. The reverse proxy must preserve the external Host header, and the browser Origin must match it.

Supabase requests use Node's built-in `fetch` against Auth and PostgREST, so no SDK or browser credentials are required. Access and refresh tokens stay in HttpOnly, SameSite cookies, never browser local storage or API JSON. Expired access tokens are refreshed with rotation; sessions survive application restarts. Cookies have a 30-day lifetime, subject to Supabase's session policies. Logout revokes the refresh session and clears cookies; already-issued access JWTs retain Supabase's normal validity until expiry.

The database checks authorization even when accessed directly with an authenticated Supabase client: ambassadors see only their own tickets and conversations; employees see the workspace. Mutations run through narrowly granted RPCs, with row locks for workflow transitions and database-generated ticket numbers. Routine reads and writes use the signed-in user's JWT, not the privileged key. Profile roles and product administration remain administrator-only.

Self-service signup, invite-link/password-recovery screens, Storage uploads, Realtime subscriptions, and incoming email are not implemented. Provision passwords through trusted administration; do not send invite/recovery links to this app expecting a callback flow. The existing ten-second polling remains enabled. Existing JSON data/password hashes are **not** automatically imported: provision Auth accounts and migrate records separately with deliberate UUID mapping if needed.

## Email

Without a provider, **Åpne e-postutkast** opens the user's email application with the contact's address and ticket reference. Drafts are not sent or recorded automatically.

For outbound email notifications, configure `RESEND_API_KEY` and `EMAIL_FROM` in the server environment. The message composer then offers **Send også en e-postvarsling**. Recipients come from the assigned contact/ambassador, never from an arbitrary address supplied by a client. Messages are stored before delivery is attempted, and a failed email is visibly marked without losing the conversation.

The demo accounts use non-deliverable `.example` addresses. Actual delivery requires authorised recipient addresses and a verified sender with Resend. In Supabase mode, also configure `SUPABASE_SERVICE_ROLE_KEY`; without it, the email checkbox stays disabled. That privileged key is used only by the server to record delivery status, never for user-facing database access. Notification failure leaves the saved message intact; failure to record a successful delivery conservatively retains the failure marker, so check provider logs before retrying. Never commit credentials or personal data.

**Incoming email replies are not imported.** Reply in the portal to keep conversations together. A production deployment would need a verified inbound email integration to support two-way email synchronisation.

## Checks

```sh
npm test
npm run check
```

Tests use Node's built-in test runner and temporary storage. They cover authentication, permissions, persistence, ticket creation, status/assignment updates, conversations, email delivery failure, invalid requests, account-switch refresh races, and draft preservation during metadata saves. Supabase HTTP tests use a mocked provider and cover token rotation, restart-safe sessions, trusted profiles, sanitized failures, RPC routing, and credential separation.

Database regression checks are in `supabase/tests/portal.sql`. Run them with `psql -v ON_ERROR_STOP=1 -f supabase/tests/portal.sql` against an **isolated test database** after applying the migration, using an administrator connection. The checks use fixtures and roll back changes; they must not run against production.

## Deployment boundary

The local JSON mode is a **single-process demonstration**. Do not expose its public accounts or use real customer data; the JSON store must not be shared between server processes.

Supabase mode supports shared database persistence and authentication across application instances, but still needs deployment-specific hardening: trusted account administration and recovery, HTTPS, gateway rate limits, audit/retention policies, Supabase backup/session settings, and real catalogue/email configuration. Keep privileged keys exclusively in server secrets. Configure project-wide Auth rate limits and session lifetimes before exposing the portal.
