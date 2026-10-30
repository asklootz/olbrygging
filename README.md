# olbrygging

A Norwegian-language ambassador CRM for Ølbrygging AS, with PocketBase-backed and standalone local demo modes:

- An illustrated, searchable product catalogue with category filters.
- Promotion requests with a link to the olbrygging.no product and its current name, price, image, and description, plus idea, channel, and publication date.
- Ambassador-specific collaboration lists and progress tracking.
- Employee review, approval, assignment, deadlines, and completion.
- Persistent ticket conversations, email drafts, and optional outbound email notifications.
- PocketBase password authentication, SQLite persistence, and backend-enforced role and ticket access checks.
- A dependency-free local demo with password authentication and JSON storage.
- Ambassador profiles, employee task filters, a searchable knowledge base, and product damage reports.
- Browser-saved display/notification preferences and administrator-only account management.
- Password authentication and server-side role and ticket access checks.
- Responsive desktop/mobile layouts and keyboard-accessible dialogs.
- Installable PWA with a cached public app shell and mobile safe-area support.

## Install and run PocketBase with npm

Requires **Node.js 22.9 or newer** and npm. PocketBase is a **native executable**, not a Node database server. The pinned npm launcher downloads and runs the official **PocketBase 0.40.6** binary for Linux, macOS, or Windows (x64/arm64); no Go toolchain is needed.

```sh
npm ci
npm run pocketbase:install
npm run dev
```

`npm run dev` starts PocketBase at **http://127.0.0.1:8090** and the portal at **http://127.0.0.1:3000**, applies the checked-in migrations automatically, waits for backend readiness, and stops both processes on Ctrl+C. Binary downloads require access to GitHub releases. The binary and database are ignored by Git. No public demo users are created in PocketBase.

Open the PocketBase dashboard at **http://127.0.0.1:8090/_/** and follow its first-run superuser setup link printed in the terminal. Alternatively, create a superuser using the native CLI through npm:

```sh
npm run pocketbase -- superuser create <admin-email> <admin-password>
```

Use your own credentials and do not commit them; command arguments may be recorded in shell history. In the dashboard's **users** collection, create at least one `employee` and one `ambassador`, each with a name, email and password. Sign into the portal using those accounts, **not** the superuser. Only superusers can provision users, change roles, or administer products. The migration seeds eight fictional products; replace them before real use.

### Import existing local users

The trusted local database owner can import accounts from the JSON workspace without creating a superuser or exposing a public import endpoint. **Stop PocketBase first and back up its data directory.** The importer defaults to a dry run and never changes the source workspace. For the existing fictional demo accounts:

```sh
npm run pocketbase:import-users -- --demo-passwords
npm run pocketbase:import-users -- --demo-passwords --apply
npm run dev
```

This imports active `employee` and `ambassador` profiles into PocketBase's **users** auth collection. Local `admin` and inactive accounts are skipped. PocketBase generates new IDs; existing accounts matched by email are left completely unchanged, including their passwords and roles. New accounts are saved in one transaction, so an invalid record rolls back the entire batch. Tickets, messages and other workspace records are **not** imported.

`--demo-passwords` reuses the public password in the demo table below **only** for addresses ending in `@olbrygging.example` whose stored scrypt hash matches it. It never treats a hash as a password or guesses credentials for real accounts. Sign into the portal with the imported email and password; login and subsequent session validation are handled by PocketBase.

For real accounts, supply `--passwords-file` pointing to a private JSON object mapping normalized, lowercase email addresses to **new** passwords (12–72 UTF-8 bytes). The old scrypt hashes cannot be converted to PocketBase passwords. Keep this file outside Git, deliver new passwords securely, and remove it after import. Password values are not accepted as command-line arguments or printed. For example:

```sh
npm run pocketbase:import-users -- --source /private/workspace.json --passwords-file /private/passwords.json
npm run pocketbase:import-users -- --source /private/workspace.json --passwords-file /private/passwords.json --apply
```

`--source` defaults to `DATA_FILE` or the repository's local workspace; `--dir` overrides the local PocketBase data directory. This is an offline local-database operation, not a remote import through `POCKETBASE_URL`. Do not point it at a data directory used by a running PocketBase process. Back up and verify account counts and logins before retiring the old workspace.

Both import and normal backend startup apply pending migrations. An additive upgrade repairs older installations missing profile fields, product snapshots, articles or damage reports, while preserving existing accounts and tickets.

For separate terminals or an existing PocketBase server:

```sh
# Terminal 1: native backend, with repository migrations and hooks
npm run pocketbase:start

# Terminal 2: copy .env.example to .env, then run only the Node portal
npm start
```

`npm start` and `npm run dev` load `.env` if present. `npm start` uses `http://127.0.0.1:8090` by default; set `POCKETBASE_URL` for another backend. `npm run dev` sets the local URL automatically and rejects external URLs. An external PocketBase deployment must install this repository's `pb_migrations` and `pb_hooks`, not just run an empty server.

### Optional JSON demo

Use `npm run demo` to explicitly start the standalone JSON demo. An explicitly empty `POCKETBASE_URL` also selects this mode; an absent variable now defaults to PocketBase rather than silently selecting JSON authentication. Open **http://127.0.0.1:3000** and use the demo-role buttons or log in with:

| Role | Email | Password |
| --- | --- | --- |
| Ambassador | `ambassador@olbrygging.example` | `BrewTogether!2026` |
| Employee | `employee@olbrygging.example` | `BrewTogether!2026` |
| Second ambassador | `sara@olbrygging.example` | `BrewTogether!2026` |
| Second employee | `marius@olbrygging.example` | `BrewTogether!2026` |
| Administrator | `admin@olbrygging.example` | `BrewTogether!2026` |

These are public **demo credentials**, not real accounts. Catalogue products, people, and conversations are fictional examples. When creating a ticket, provide a product page URL from `www.olbrygging.no` to fetch product details for the ticket; this does not make the example catalogue or ticket workflow a live commerce integration.

In local demo mode, the administrator account can create employee and ambassador accounts from **Brukeradministrasjon**. New accounts require a temporary password of at least 12 characters. PocketBase account and role administration remains restricted to superusers; the app does not send invitations or password-reset messages.

### Try the workflow

1. Log in as an ambassador, select a catalogue product, provide its `www.olbrygging.no` product-page URL, and submit a promotion idea. Product details are fetched from that page and linked from the ticket.
2. Log out and log in as an employee. Open the request, select a contact person, and approve it.
3. As the ambassador, move the approved collaboration to **Pågår**, exchange messages with the contact person, and submit it **Til gjennomgang**.
4. The employee can complete the collaboration or return it for further work.

The workspace refreshes conversations periodically while open. Messages and ticket changes persist across restarts.

## Install on a phone

After opening the portal online, use **Install app / Add to Home screen** in Chrome on Android, or **Share → Add to Home Screen** in Safari on iPhone/iPad. Launch the home-screen icon for a standalone window.

Service workers and installation require **HTTPS**, except on localhost. A phone accessing a computer's LAN HTTP address cannot install the full PWA. For a controlled mobile demo, serve through HTTPS, configure the server's `HOST` for the intended network, and set `COOKIE_SECURE=true`; do not publicly expose the demo accounts.

After the first successful online visit, the public app shell is available offline. Login, products, collaborations, messages and logout still require the server. An offline reload shows a connection message and **Prøv igjen**; reconnect and retry. No API responses or private workspace data are stored in the PWA cache, and writes are not queued. Drafts stay in memory while the page remains open, but do not survive closing or reloading it. Network loss during submission can leave delivery uncertain; check the conversation before resending.

Updates activate after all portal windows are closed, avoiding forced reloads while composing. When changing shell assets, bump the cache version in `public/sw.js` so the next worker installs the complete matching shell.

## Storage and configuration

In local demo mode, the first launch seeds `data/workspace.json`. Writes are atomic; the data folder is ignored by Git. Stop the server and delete this file to reset the demo. Back it up to preserve changes. Demo sessions are held in memory and expire after 12 hours or a server restart.

When PocketBase is configured, no local JSON workspace or demo accounts are created or read. Database/authentication failures never fall back to the demo. PocketBase stores its SQLite database, settings, and uploads in `pb_data/`. Back up this directory using PocketBase's backup facility and keep credentials/backups outside Git. Do not delete it to upgrade the executable.

| Variable | Default / purpose |
| --- | --- |
| `HOST` | `127.0.0.1` — local access only |
| `PORT` | `3000` |
| `DATA_FILE` | `data/workspace.json` |
| `POCKETBASE_URL` | Defaults to `http://127.0.0.1:8090`; HTTPS required except for loopback HTTP. Explicitly empty selects the JSON demo |
| `POCKETBASE_ADMIN_EMAIL` | Optional **server-only** superuser email for recording email delivery outcomes |
| `POCKETBASE_ADMIN_PASSWORD` | Matching superuser password; both admin settings must be supplied together |
| `RESEND_API_KEY` | Optional outbound email provider key |
| `EMAIL_FROM` | Verified sender address for Resend |
| `COOKIE_SECURE` | Set to `true` only when serving through HTTPS |
| `NODE_ENV` | `production` refuses startup without PocketBase and `COOKIE_SECURE=true` |

### Authentication and access

The Node API uses built-in `fetch`; no SDK or credentials are exposed to the browser. PocketBase auth tokens stay in an HttpOnly, SameSite cookie (Secure under HTTPS), and are validated/refreshed server-side using the `users` auth collection. Browser sessions last at most 12 hours from login and survive Node restarts. Only login/logout change the browser cookie; background requests cannot restore a logged-out account or overwrite a later login. **PocketBase tokens are stateless:** logout clears the browser cookie but does not individually revoke a copied token. Reset the user's password or rotate their token key in trusted administration to invalidate existing tokens.

Backend hooks enforce access even if a caller bypasses Node: ambassadors see only their own tickets and conversations, while employees see the workspace. Direct collection writes and public account creation are locked; custom routes validate fields and execute workflow changes in database transactions with unique sequential ticket numbers. Routine requests use the signed-in user's token. Superuser credentials are optional and used only when recording email delivery outcomes.

Self-service signup, invite-link/password-recovery screens, uploads, realtime subscriptions, and incoming email are not implemented. Provision and recover accounts through trusted administration. The existing ten-second workspace polling remains enabled.

### Migrating from Supabase

Supabase support, environment variables, SQL migrations, and provider-specific tests have been removed. Startup does **not** connect to, modify, or automatically import an existing Supabase project or JSON workspace. Use the explicit local-user importer above for JSON accounts, or provision accounts through trusted administration. Supabase exports and ticket/message migration are not supported by this importer. Explicitly map old user/ticket/message IDs when implementing a full data migration. Password hashes and sessions are not portable; real accounts need new passwords. Preserve old data/backups until a deliberate import has been verified.

## Email

Without a provider, **Åpne e-postutkast** opens the user's email application with the contact's address and ticket reference. Drafts are not sent or recorded automatically.

For outbound email notifications, configure `RESEND_API_KEY` and `EMAIL_FROM` in the server environment. The message composer then offers **Send også en e-postvarsling**. Recipients come from the assigned contact/ambassador, never from an arbitrary address supplied by a client. Messages are stored before delivery is attempted, and a failed email is visibly marked without losing the conversation.

The demo accounts use non-deliverable `.example` addresses. Actual delivery requires authorised recipient addresses and a verified sender with Resend. In PocketBase mode, also configure `POCKETBASE_ADMIN_EMAIL` and `POCKETBASE_ADMIN_PASSWORD`; without them, the email checkbox stays disabled. Those server-only credentials authenticate a superuser only to record delivery status, never for routine user-facing database access. Notification failure leaves the saved message intact; failure to record a successful delivery conservatively retains the failure marker, so check provider logs before retrying. Never commit credentials or personal data.

**Incoming email replies are not imported.** Reply in the portal to keep conversations together. A production deployment would need a verified inbound email integration to support two-way email synchronisation.

## Checks

```sh
npm test
npm run check
npm run test:integration
```

Tests use Node's built-in test runner and temporary storage. They cover authentication, permissions, persistence, ticket creation, status/assignment updates, conversations, email delivery failure, invalid requests, account-switch refresh races, and draft preservation during metadata saves. PocketBase adapter tests use a mocked backend and check cookie refresh, restart-safe sessions, trusted roles, sanitized failures, endpoint routing, and privileged credential separation.

The real backend suite starts an isolated PocketBase instance with temporary data and exercises migrations, authorization, workflow validation, concurrency, and transactional/idempotent user import followed by portal login. It skips if the native executable has not been installed; `npm run test:integration` downloads the pinned binary first and explicitly runs that suite. It never uses the live `pb_data/` directory. `npm audit` checks npm dependencies; the native PocketBase executable has its own release/security lifecycle.

## Deployment boundary

The local JSON mode is a **single-process demonstration**. Do not expose its public accounts or use real customer data; the JSON store must not be shared between server processes.

For deployment, run one PocketBase service with persistent storage; Node portal instances may connect to that service. Do not share its SQLite data directory between independent PocketBase processes. Use process/service supervision rather than the development launcher, keep PocketBase and its dashboard on a private network where possible, enforce HTTPS (`COOKIE_SECURE=true`, `NODE_ENV=production`), and configure `HOST` for your hosting environment. The reverse proxy must preserve the external Host header, and the browser Origin must match it.

Before using real data, configure trusted account administration/recovery, gateway and PocketBase rate limits, backups, audit/retention policies, and real catalogue/email integrations. Protect superuser access. PocketBase is pre-1.0; review compatibility and security notes before upgrading the pinned native version.
