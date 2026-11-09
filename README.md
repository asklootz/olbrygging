# olbrygging

A Norwegian-language ambassador CRM for Ølbrygging AS, with PocketBase-backed and standalone local demo modes:

- URL-based promotion requests with fetched product name, price, image, and description, plus idea, channel, publication date, and optional multiple independently tracked promotion instances. Ambassador and employee pages do not include a browsable product catalogue.
- Ambassador-specific collaboration lists and progress tracking.
- Employee review, approval, assignment, deadlines, and completion.
- Versioned image/video submissions with private previews, approval or change requests, reviewer feedback, and a required post URL before closure.
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

Use your own credentials and do not commit them; command arguments may be recorded in shell history. In the dashboard's **users** collection, create at least one `employee` and one `ambassador`, each with a name, email and password. Sign into the portal using those accounts, **not** the superuser. Only superusers can provision staff, change roles, or administer product reference data. To grant application-review access, set `isPortalAdmin` to true for a trusted `employee` account in the **users** collection; do not grant it to ambassadors. These portal administrators can create ambassador accounts by approving applications. Product records remain available for damage-report links and older tickets; there is no product catalogue page in the portal.

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

These are public **demo credentials**, not real accounts. People and conversations are fictional examples. When creating a ticket, provide a product page URL from `www.olbrygging.no` to fetch product details for the ticket; this does not make the ticket workflow a live commerce integration.

In local demo mode, the administrator account can create employee and ambassador accounts from **Brukeradministrasjon**. New accounts require a temporary password of at least 12 characters. Application invitations are available only in PocketBase mode; password-reset messages are not implemented.

### Try the workflow

#### Employee-created tasks

1. Sign in with an **employee** account (or the local-demo administrator) and choose **Opprett oppgave** from the overview or tasks page.
2. Paste a product-page URL from `https://www.olbrygging.no/` and select **Hent produktinfo**. The preview shows the fetched product image, name, description and price when provided by the page. A catalogue selection is not required. Creation fetches the page again on the server so a client cannot inject its own product snapshot.
3. Keep or edit the task title, write an idea/instructions, and choose **Frist for å melde interesse** and **Publiseringsfrist**. Both dates are required; the publishing date cannot precede the acceptance date. Date-only acceptance deadlines include the entire selected UTC date.
4. Choose how many ambassadors can promote the product (default **1**, maximum **50**), then publish without selecting any individuals or a publishing platform. The app creates that many `available` ticket instances with one shared numbered offer, an empty ambassador relation and channel, `acceptBy`, and the publishing `dueDate`. Existing tickets and catalogue relations are preserved by the additive migration.
5. Ambassadors see unexpired offer instances in **Mine samarbeid** and can **Aksepter oppgaven**. The first successful acceptance claims one numbered instance and changes it to `approved`; concurrent claims are resolved transactionally. Each ambassador can claim at most one instance from the same offer, so a quantity of 3 can be taken by up to 3 different ambassadors.
6. After acceptance, the ambassador may choose a publishing channel and move the task to **Pågår**. Upload up to five JPEG, PNG, WebP, MP4 or WebM files (20 MB each, 30 MB total) in the task's **Innhold og vurdering** section, with an optional caption or link. The employee reviews that version, approves it or requests changes with feedback; the ambassador can then submit a new version while earlier versions remain visible.
7. After approval, publish the post and add its HTTPS URL to the task. Employees can close the task only after an approved submission and a publication URL are present. Conversations become available after acceptance; other ambassadors no longer see that collaboration. Expired unaccepted tasks remain visible to employees but cannot be claimed.

Existing completed tickets remain unchanged. For an older ticket already marked **Til gjennomgang** without a content submission, a staff member can return it to **Pågår** so the ambassador can upload its first version.

PocketBase uses the portal `employee` role for staff task management; PocketBase superusers administer accounts and schema in the dashboard and are not portal sign-in users.

#### Ambassador-requested collaborations

1. Log in as an ambassador, choose **Send en forespørsel**, paste a `www.olbrygging.no` product-page URL, and select **Hent info**. Review the fetched details, then submit a promotion idea. Product details are fetched again by the server and linked from the ticket. No catalogue selection is required.
2. Log out and log in as an employee. Open the request, select a contact person, and approve it.
3. As the ambassador, move the approved collaboration to **Pågår**, upload images or video for review, and exchange messages with the contact person.
4. The employee approves the submission or requests changes with feedback. After approval, publish the post and add its HTTPS URL to the task.
5. The employee can complete the collaboration once its content is approved and its publication link is recorded.

When an ambassador requests a promotion, **Hvor mange promoteringer ønsker du?** defaults to **1** and accepts **1–50**. A higher value creates that many independently tracked ticket instances with the same product snapshot, idea, channel, and deadline. Each has its own status, conversation, and unique internal ticket ID/number; displayed references share the allocated base with an instance suffix (for example `1006-1`, `1006-2`, `1006-3`). Existing tickets retain their original unsuffixed numbers. All instances are assigned to the requesting ambassador and followed up separately. For employees, the same count controls how many different ambassadors can accept a URL-based offer. The database creates all instances and advances the number counter in one transaction.

The workspace refreshes conversations periodically while open. Messages and ticket changes persist across restarts.

## Install on a phone

After opening the portal online, use **Install app / Add to Home screen** in Chrome on Android, or **Share → Add to Home Screen** in Safari on iPhone/iPad. Launch the home-screen icon for a standalone window.

Service workers and installation require **HTTPS**, except on localhost. A phone accessing a computer's LAN HTTP address cannot install the full PWA. For a controlled mobile demo, serve through HTTPS, configure the server's `HOST` for the intended network, and set `COOKIE_SECURE=true`; do not publicly expose the demo accounts.

After the first successful online visit, the public app shell is available offline. Login, product previews, collaborations, messages and logout still require the server. An offline reload shows a connection message and **Prøv igjen**; reconnect and retry. No API responses or private workspace data are stored in the PWA cache, and writes are not queued. Drafts stay in memory while the page remains open, but do not survive closing or reloading it. Network loss during submission can leave delivery uncertain; check the conversation before resending.

Updates activate after all portal windows are closed, avoiding forced reloads while composing. When changing shell assets, bump the cache version in `public/sw.js` so the next worker installs the complete matching shell.

## Storage and configuration

In local demo mode, the first launch seeds `data/workspace.json`. Writes are atomic; the data folder is ignored by Git. Stop the server and delete this file to reset the demo. Back it up to preserve changes. Uploaded demo media is stored separately in a private `content-media/` directory beside the workspace file; back it up with the workspace. Removing the workspace alone does not remove uploaded media. Demo sessions are held in memory and expire after 12 hours or a server restart.

When PocketBase is configured, no local JSON workspace or demo accounts are created or read. Database/authentication failures never fall back to the demo. PocketBase stores its SQLite database, settings, and uploads in `pb_data/`. Back up this directory using PocketBase's backup facility and keep credentials/backups outside Git. Do not delete it to upgrade the executable.

| Variable | Default / purpose |
| --- | --- |
| `HOST` | `127.0.0.1` — local access only |
| `PORT` | `3000` |
| `DATA_FILE` | `data/workspace.json` |
| `POCKETBASE_URL` | Defaults to `http://127.0.0.1:8090`; HTTPS required except for loopback HTTP. Explicitly empty selects the JSON demo |
| `POCKETBASE_ADMIN_EMAIL` | Optional **server-only** superuser email for recording task-message email delivery outcomes |
| `POCKETBASE_ADMIN_PASSWORD` | Matching superuser password; both admin settings must be supplied together |
| `PUBLIC_URL` | Public HTTPS origin for ambassador password-setup links; required to deliver application invitations |
| `RESEND_API_KEY` | Optional outbound email provider key |
| `EMAIL_FROM` | Verified sender address for Resend |
| `COOKIE_SECURE` | Set to `true` only when serving through HTTPS |
| `NODE_ENV` | `production` refuses startup without PocketBase and `COOKIE_SECURE=true` |

### Authentication and access

The Node API uses built-in `fetch`; no SDK or credentials are exposed to the browser. PocketBase auth tokens stay in an HttpOnly, SameSite cookie (Secure under HTTPS), and are validated/refreshed server-side using the `users` auth collection. Browser sessions last at most 12 hours from login and survive Node restarts. Only login/logout change the browser cookie; background requests cannot restore a logged-out account or overwrite a later login. **PocketBase tokens are stateless:** logout clears the browser cookie but does not individually revoke a copied token. Reset the user's password or rotate their token key in trusted administration to invalidate existing tokens.

Backend hooks enforce access even if a caller bypasses Node: ambassadors see only their own tickets and conversations, while employees see the workspace. Direct collection writes and public account creation are locked; custom routes validate fields and execute workflow changes in database transactions with unique sequential ticket numbers. Routine requests use the signed-in user's token. Superuser credentials are optional and used only when recording email delivery outcomes.

The sign-in page offers **Søk om å bli ambassadør**. Applicants submit their name, phone, email, full address (including optional address line 2 and region), HTTPS profile links in separate Instagram, Facebook, TikTok, X/Twitter, Bluesky and YouTube fields, and required agreement to the published application terms. Each platform link is optional, but at least one must be supplied. Submission does **not** create an auth account, assign a role or sign the applicant in. A confirmation is shown only after the backend acknowledges the application; failed requests retain form input. Applications are unavailable in the standalone JSON demo.

Applications are stored in the separate private **ambassador_applications** PocketBase collection, not in auth records or workspace responses. All direct collection API rules are locked; the portal's application review endpoints are available only to employee accounts explicitly provisioned with `isPortalAdmin=true`. The public hook validates an explicit field allowlist, records `pending` status plus server-owned consent version/time, and never returns applicant details. The Node submission endpoint limits each connecting IP to ten attempts per fifteen minutes. Repeated applications for the same normalized email within 24 hours receive the same acknowledgement without overwriting the earlier record. Nothing is cached by the PWA or persisted in browser storage.

Review applications from the portal's **Søknader** page. Verify the applicant's identity/contact details before approving. Approval transactionally creates one ambassador account and links it to the application; the applicant is emailed a random, single-use, 48-hour link to set their own password (no password is emailed). Declining changes the application status without creating an account. Duplicate/concurrent decisions are rejected, and an email failure is recorded separately from approval; administrators can retry, which rotates the password-setup token without creating another account. An existing account with the same email causes approval to fail for manual identity review rather than linking it automatically. All direct collection API rules remain locked.

The initial application terms describe this submission/review flow only; review them with the business and publish appropriate privacy/retention/contact information before collecting real applicants. Bump the server's consent version and the published terms together when changing them. Add gateway/CAPTCHA protection as appropriate and configure PocketBase rate limits for the public `/api/portal/ambassador-applications` hook if it can be reached directly; the Node limiter cannot protect requests bypassing Node. Behind a proxy, the current Node limiter deliberately uses the connecting proxy IP rather than trusting spoofable forwarding headers.

Self-service public signup, password recovery, realtime subscriptions, and incoming email are not implemented; invited ambassadors can set their password once using the application invitation link. Content media uses private, authenticated storage, is not included in workspace polling or PWA caches, and is limited to the supported formats and upload sizes above. File validation is not malware scanning; establish scanning, storage quotas, retention and backup procedures before accepting real media. Provision administrator flags and recover existing accounts through trusted administration. The existing ten-second workspace polling remains enabled.

### Migrating from Supabase

Supabase support, environment variables, SQL migrations, and provider-specific tests have been removed. Startup does **not** connect to, modify, or automatically import an existing Supabase project or JSON workspace. Use the explicit local-user importer above for JSON accounts, or provision accounts through trusted administration. Supabase exports and ticket/message migration are not supported by this importer. Explicitly map old user/ticket/message IDs when implementing a full data migration. Password hashes and sessions are not portable; real accounts need new passwords. Preserve old data/backups until a deliberate import has been verified.

## Email

Without a provider, **Åpne e-postutkast** opens the user's email application with the contact's address and ticket reference. Drafts are not sent or recorded automatically.

For outbound email notifications and ambassador setup invitations, configure `RESEND_API_KEY` and `EMAIL_FROM` in the server environment. Set `PUBLIC_URL` to the portal's public HTTPS origin so invitation links point to the deployed service. A missing provider or public URL does not discard an approved application/account: delivery is marked failed and an administrator can retry after configuration is fixed. The message composer then offers **Send også en e-postvarsling**. Recipients come from the assigned contact/ambassador or reviewed application, never from an arbitrary address supplied by a client. Messages and account decisions are stored before delivery is attempted, and a failed email is visibly marked.

The demo accounts use non-deliverable `.example` addresses. Actual delivery requires authorised recipient addresses and a verified sender with Resend. Task-message email notifications in PocketBase mode also require `POCKETBASE_ADMIN_EMAIL` and `POCKETBASE_ADMIN_PASSWORD`; without them, the email checkbox stays disabled. Those server-only credentials authenticate a superuser only to record task-message delivery status, never for routine user-facing database access. Ambassador invitations use the signed-in, explicitly provisioned portal administrator to record delivery status and do not require PocketBase superuser credentials. Notification failure leaves saved data intact; check provider logs before retrying. Never commit credentials or personal data.

**Incoming email replies are not imported.** Reply in the portal to keep conversations together. A production deployment would need a verified inbound email integration to support two-way email synchronisation.

## Checks

```sh
npm test
npm run check
npm run test:integration
```

Tests use Node's built-in test runner and temporary storage. They cover authentication, permissions, persistence, ticket creation, status/assignment updates, versioned content submissions, upload validation and access, review feedback, publication requirements, conversations, email delivery failure, invalid requests, account-switch refresh races, and draft preservation during metadata saves. PocketBase adapter tests use a mocked backend and check cookie refresh, restart-safe sessions, trusted roles, sanitized failures, endpoint routing, and privileged credential separation.

The real backend suite starts an isolated PocketBase instance with temporary data and exercises migrations, authorization, workflow validation, concurrency, and transactional/idempotent user import followed by portal login. It skips if the native executable has not been installed; `npm run test:integration` downloads the pinned binary first and explicitly runs that suite. It never uses the live `pb_data/` directory. `npm audit` checks npm dependencies; the native PocketBase executable has its own release/security lifecycle.

## Deployment boundary

The local JSON mode is a **single-process demonstration**. Do not expose its public accounts or use real customer data; the JSON store must not be shared between server processes.

For deployment, run one PocketBase service with persistent storage; Node portal instances may connect to that service. Do not share its SQLite data directory between independent PocketBase processes. Use process/service supervision rather than the development launcher, keep PocketBase and its dashboard on a private network where possible, enforce HTTPS (`COOKIE_SECURE=true`, `NODE_ENV=production`), and configure `HOST` for your hosting environment. The reverse proxy must preserve the external Host header, and the browser Origin must match it.

Before using real data, configure trusted account administration/recovery, gateway and PocketBase rate limits, backups, audit/retention policies, and real catalogue/email integrations. Protect superuser access. PocketBase is pre-1.0; review compatibility and security notes before upgrading the pinned native version.

## Container and GitHub Actions

The repository ships a single-container deployment (`Dockerfile`) that runs the pinned PocketBase 0.40.6 binary and the Node portal in one process: the container exposes only the portal port (3000), PocketBase stays on loopback inside the container, and its data lives in `PB_DATA_DIR` (mount a volume there). On first boot, `pb_migrations/1792401000_bootstrap_superuser.js` creates the superuser from `POCKETBASE_ADMIN_EMAIL` / `POCKETBASE_ADMIN_PASSWORD` when both are set; an existing data directory with a superuser is left untouched.

GitHub Actions workflows (`.github/workflows/`):

- **CI** (`ci.yml`): on every push and pull request to `main`, runs `npm test`, `npm run test:integration` (which downloads the pinned PocketBase 0.40.6 binary) and `npm run check` on Node 22 and 24, and builds the container image.
- **Publish container image** (`container.yml`): on push to `main` (and manually via Actions), builds and pushes the image to `ghcr.io/asklootz/olbrygging` tagged `latest` and with the short commit SHA. For a private repository, allow package access under **Settings → General → Visibility, feature sets and limitations → Package visibility**.
- **Publish via actions** (`publish.yml`): deploys the static `public/` app shell to GitHub Pages.

Pull and run the published image:

```sh
docker pull ghcr.io/asklootz/olbrygging:latest
docker run -d --name olbrygging --restart unless-stopped -p 3000:3000 \
  -e POCKETBASE_ADMIN_EMAIL=<admin-email> \
  -e POCKETBASE_ADMIN_PASSWORD=<admin-password> \
  -v olbrygging-pb-data:/pb-data \
  ghcr.io/asklootz/olbrygging:latest
```

Configure the remaining server environment (`RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_URL`, ...) as container environment variables or a mounted secret file; the image defaults to `NODE_ENV=production` and `COOKIE_SECURE=true`, so serve it behind HTTPS.

