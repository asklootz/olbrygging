# olbrygging

A Norwegian-language ambassador CRM for Ølbrygging AS. This standalone local demo includes:

- An illustrated, searchable product catalogue with category filters.
- Promotion requests with product, idea, channel, and publication date.
- Ambassador-specific collaboration lists and progress tracking.
- Employee review, approval, assignment, deadlines, and completion.
- Persistent ticket conversations, email drafts, and optional outbound email notifications.
- Ambassador profiles, employee task filters, a searchable knowledge base, and product damage reports.
- Browser-saved display/notification preferences and administrator-only account management.
- Password authentication and server-side role and ticket access checks.
- Responsive desktop/mobile layouts and keyboard-accessible dialogs.

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
| Administrator | `admin@olbrygging.example` | `BrewTogether!2026` |

These are public **demo credentials**, not real accounts. All products, prices, people, and conversations are fictional examples, not a live olbrygging.no integration.

Administrators can create employee and ambassador accounts from **Brukeradministrasjon**. New accounts require a temporary password of at least 12 characters. The app does not send invitations or password-reset messages.

### Try the workflow

1. Log in as an ambassador, select a product, and submit a promotion idea.
2. Log out and log in as an employee. Open the request, select a contact person, and approve it.
3. As the ambassador, move the approved collaboration to **Pågår**, exchange messages with the contact person, and submit it **Til gjennomgang**.
4. The employee can complete the collaboration or return it for further work.

The workspace refreshes conversations periodically while open. Messages and ticket changes persist across restarts.

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

Tests use Node's built-in test runner and temporary storage. They cover authentication, permissions, persistence, ticket creation, status/assignment updates, conversations, email delivery failure, invalid requests, account-switch refresh races, and draft preservation during metadata saves.

## Deployment boundary

This is a **single-process local demonstration**, not a production-ready hosted CRM. Do not expose the public demo accounts or use real customer data. Before deployment, replace demo provisioning with secure account administration/SSO, enforce HTTPS and secure cookies, implement account recovery and audit/retention policies, configure real catalogue and email integrations, and use a production database with backups and multi-process concurrency support. The JSON store must not be shared between server processes.
