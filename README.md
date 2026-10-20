# olbrygging

A Norwegian-language ambassador CRM for Ølbrygging AS. This standalone local demo includes:

- An illustrated, searchable product catalogue with category filters.
- Promotion requests with a link to the olbrygging.no product and its current name, price, image, and description, plus idea, channel, and publication date.
- Ambassador-specific collaboration lists and progress tracking.
- Employee review, approval, assignment, deadlines, and completion.
- Persistent ticket conversations, email drafts, and optional outbound email notifications.
- Password authentication and server-side role and ticket access checks.
- Responsive desktop/mobile layouts and keyboard-accessible dialogs.
- Installable PWA with a cached public app shell and mobile safe-area support.

## Run

Requires **Node.js 22 or newer**. No packages, external assets, database service, or build step are needed.

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

These are public **demo credentials**, not real accounts. Catalogue products, people, and conversations are fictional examples. When creating a ticket, provide a product page URL from `www.olbrygging.no` to fetch product details for the ticket; this does not make the example catalogue or ticket workflow a live commerce integration.

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

The first launch seeds `data/workspace.json`. Writes are atomic; the data folder is ignored by Git. Stop the server and delete this file to reset the demo. Back it up to preserve changes. Sessions are held in memory and expire after 12 hours or a server restart.

| Variable | Default / purpose |
| --- | --- |
| `HOST` | `127.0.0.1` — local access only |
| `PORT` | `3000` |
| `DATA_FILE` | `data/workspace.json` |
| `RESEND_API_KEY` | Optional outbound email provider key |
| `EMAIL_FROM` | Verified sender address for Resend |
| `COOKIE_SECURE` | Set to `true` only when serving through HTTPS |

## Email

Without a provider, **Åpne e-postutkast** opens the user's email application with the contact's address and ticket reference. Drafts are not sent or recorded automatically.

For outbound email notifications, configure `RESEND_API_KEY` and `EMAIL_FROM` in the server environment. The message composer then offers **Send også en e-postvarsling**. Recipients come from the assigned contact/ambassador, never from an arbitrary address supplied by a client. Messages are stored before delivery is attempted, and a failed email is visibly marked without losing the conversation.

The demo accounts use non-deliverable `.example` addresses. Actual delivery requires replacing these with authorised recipient addresses in your private data file and configuring a verified sender with Resend. Never commit credentials or personal data.

**Incoming email replies are not imported.** Reply in the portal to keep conversations together. A production deployment would need a verified inbound email integration to support two-way email synchronisation.

## Checks

```sh
npm test
npm run check
```

Tests use Node's built-in test runner and temporary storage. They cover authentication, permissions, persistence, ticket creation, product URL validation and metadata, status/assignment updates, conversations, email delivery failure, invalid requests, account-switch refresh races, and draft preservation during metadata saves.

## Deployment boundary

This is a **single-process local demonstration**, not a production-ready hosted CRM. Do not expose the public demo accounts or use real customer data. Before deployment, replace demo provisioning with secure account administration/SSO, enforce HTTPS and secure cookies, implement account recovery and audit/retention policies, configure real catalogue and email integrations, and use a production database with backups and multi-process concurrency support. The JSON store must not be shared between server processes.
