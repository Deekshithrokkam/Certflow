# CertFlow

Bulk certificate sending from your own Gmail account. React + Vite + TypeScript + Tailwind frontend; Node.js + Express + TypeScript backend. **No database, Redis, persistent server history, or cloud certificate storage.**

## Start here

1. Install Node.js 24 LTS and npm.
2. Open a terminal in the extracted `certflow/` directory.
3. Run `npm ci` to install both workspaces from the included lockfile.
4. Copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to `frontend/.env`.
5. Generate a session secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and put the value in `backend/.env` as `SESSION_SECRET`.
6. Complete the Google setup below and fill in your client ID and client secret **only in the backend environment**.
7. In one terminal run `npm run dev:api`. In another run `npm run dev:web`.
8. Open `http://localhost:5173`, choose **Continue with Google**, and connect your account.

The landing page and empty workspace can be viewed without Google credentials. Uploading, previewing real batch data and sending require an authenticated session. Missing credentials produce a setup error; there is no fake sign-in or production mock sender.

### Install separately if needed

From `frontend/`: run `npm install`, then `npm run dev` or `npm run build`.

From `backend/`: run `npm install`, then `npm run dev`, or `npm run build` followed by `npm start`.

Use the root `npm ci` for reproducible production installs. Both directories are npm workspaces, so the root lockfile is authoritative. Keep the full repository when deploying either workspace; frontend types reference backend TypeScript types.

## Google Cloud setup, step by step

1. Open [Google Cloud Console](https://console.cloud.google.com/) and choose **Select a project → New project**. Give it a name such as `CertFlow`.
2. Open **APIs & Services → Library**, find **Gmail API**, and choose **Enable** for this project.
3. Open **Google Auth Platform** (or **APIs & Services → OAuth consent screen**). Complete Branding with the app name, support email, developer contact and, when publishing, your application homepage and privacy policy. Use contact details and domains you control.
4. Under Audience, use **Internal** only if this app is limited to your eligible Google Workspace organization. Otherwise select **External**. While testing, add the exact Google accounts you will use under **Test users**.
5. Under Data Access, configure exactly these scopes:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email` (requested as the standard `email` OpenID scope)
   - `https://www.googleapis.com/auth/gmail.send`
6. Go to **Clients → Create client** (or **Credentials → Create credentials → OAuth client ID**) and choose **Web application**.
7. Name the client, for example `CertFlow local development`.
8. Add `http://localhost:5173` under **Authorized JavaScript origins**. Authentication itself is a backend authorization-code flow; there is no browser client secret or frontend OAuth SDK.
9. Add the exact development callback below under **Authorized redirect URIs**:

   `http://localhost:5173/api/auth/google/callback`

10. Copy the client ID and client secret into `backend/.env`:

```dotenv
PORT=5000
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-secret
GOOGLE_REDIRECT_URI=http://localhost:5173/api/auth/google/callback
SESSION_SECRET=your-generated-random-secret
COOKIE_SAME_SITE=lax
```

11. Leave `VITE_API_URL=` empty in `frontend/.env`. Vite forwards `/api` and `/socket.io` to the backend on port 5000. This keeps the sign-in cookie on the same browser origin.
12. Restart the backend after editing environment variables. Click Continue with Google and approve the requested send permission.

Never enter a Gmail password, app password or SMTP password into CertFlow. Google credentials and OAuth tokens remain on the backend. Tokens live in process memory only and are lost on restart. A fresh connection will then be required.

`gmail.send` is a sensitive scope. Public availability may require Google's OAuth verification; external apps in testing have test-user and token-lifetime restrictions. Follow the current [scope documentation](https://developers.google.com/workspace/gmail/api/auth/scopes), [OAuth web server guide](https://developers.google.com/identity/protocols/oauth2/web-server), and Google Console requirements before making the app broadly available. CertFlow does not request inbox-read or mailbox-modification access.

### Development versus production URLs

| Setting | Local, using Vite proxy | Production, using Vercel proxy |
|---|---|---|
| Frontend URL / JS origin | `http://localhost:5173` | `https://YOUR-APP.vercel.app` |
| Physical backend | `http://localhost:5000` | `https://YOUR-API.onrender.com` |
| OAuth redirect URI | `http://localhost:5173/api/auth/google/callback` | `https://YOUR-APP.vercel.app/api/auth/google/callback` |
| `FRONTEND_URL` | `http://localhost:5173` | `https://YOUR-APP.vercel.app` |
| `VITE_API_URL` | empty | empty |
| `COOKIE_SAME_SITE` | `lax` | `lax` |
| `NODE_ENV` | `development` | `production` |

Redirect URIs must match exactly, including scheme, hostname, path and port. Do not add a trailing slash to the callback. Use a stable production frontend domain, not a changing preview URL. Separate local and production OAuth clients are recommended.

## Deploy backend to Render

The included `render.yaml` creates **one Node web service**. It creates no databases or disks. It defaults to a free instance. Free instances can sleep and are suitable for initial setup; choose an always-on paid instance with enough memory before relying on long batches.

1. Put the extracted source into a Git repository you control and connect that repository to Render. Do not commit `.env` files.
2. Create a **Web Service** or import the root `render.yaml` Blueprint.
3. Keep the repository root as the service root; the build uses npm workspaces.
4. Build command: `npm ci --include=dev && npm run build -w backend`.
5. Start command: `npm start -w backend`.
6. Set Node to `24.19.0` or a compatible patched Node 24 release.
7. Set `NODE_ENV=production`, your production `FRONTEND_URL`, the three Google variables, `SESSION_SECRET`, and `COOKIE_SAME_SITE=lax`.
8. Use `/api/health` as the health check. Render supplies `PORT`; the server reads it.
9. Keep exactly **one instance**. Multiple instances cannot share OAuth sessions, active batches, sockets or temporary files without persistence, which this application deliberately does not introduce.
10. Deploy and note the HTTPS `.onrender.com` URL.

Automatic deployment is disabled in the Blueprint so an ordinary commit does not unexpectedly interrupt a batch. Stop or finish active batches before a manual deploy or service restart. A free instance can sleep or restart and should not be treated as a durable batch worker. Even an always-on instance does not provide crash recovery.

See [Render's Node/Express deployment guide](https://render.com/docs/deploy-node-express-app).

## Deploy frontend to Vercel

### Recommended: same-origin proxy

This mode avoids dependence on third-party cookies between `vercel.app` and `onrender.com`.

1. After Render provides the backend hostname, run from the project root:

```sh
node scripts/configure-vercel.mjs https://YOUR-API.onrender.com
```

This replaces the two backend destinations in `frontend/vercel.json`. Commit that file. The uppercase hostname in the shipped configuration is an explicit deployment parameter, not an implemented API endpoint.

2. Import the same repository into Vercel. Set **Root Directory** to `frontend` and framework to **Vite**.
3. Enable inclusion of files outside the root directory if the project setting asks; the frontend uses a type-only import from `backend/src/types.ts`.
4. Use the included build command `npm run build` and output directory `dist`. Vercel should install the npm workspace using the repository lockfile. If overriding installation, use `cd .. && npm ci` from the frontend root.
5. Leave `VITE_API_URL` empty. Requests go to the frontend origin and are forwarded by the configured rewrites. Do not put client secrets or OAuth tokens into any `VITE_*` variable.
6. Deploy. Check `https://YOUR-APP.vercel.app/api/health` returns JSON, not the SPA HTML.
7. In Render set `FRONTEND_URL=https://YOUR-APP.vercel.app` and `GOOGLE_REDIRECT_URI=https://YOUR-APP.vercel.app/api/auth/google/callback`.
8. In the production Google OAuth client add the frontend origin and that exact production callback URI.
9. Redeploy/restart after the environment changes. Connect Google from the production frontend and run the controlled acceptance test below.

The final rewrite serves `index.html` for React Router routes, so reloading `/app/history` works. API and Socket.IO rewrites come first. API responses and socket responses must not be cached. The provided configuration disables external rewrite caching for these paths.

Socket.IO uses authenticated polling and upgrades to WebSocket where the route permits it. If a proxy does not support the upgrade, polling remains a real live transport; a five-second authenticated status fetch also reconciles active batches. Validate the actual deployment's upload-size and timeout limits with representative files. For large ZIPs or direct WebSockets, use same-site custom domains as described next.

See [Vercel external rewrites](https://vercel.com/docs/routing/rewrites).

### Alternative: direct Render API

Set `VITE_API_URL=https://YOUR-API.onrender.com` and the callback to `https://YOUR-API.onrender.com/api/auth/google/callback`. Set `COOKIE_SAME_SITE=none` on Render because these provider domains are cross-site. Keep `FRONTEND_URL` as your exact Vercel origin. CORS permits only that configured origin and sends credentialed responses.

**Browser limitation:** third-party-cookie blocking can prevent this provider-domain arrangement from retaining a login. Prefer the same-origin proxy, or use `app.your-domain.com` on Vercel and `api.your-domain.com` on Render. With same-site HTTPS custom domains, use `VITE_API_URL=https://api.your-domain.com`, the API callback URI, and `COOKIE_SAME_SITE=lax`. This also allows direct Socket.IO connections without routing through Vercel.

## The complete workflow

1. Connect Gmail and create a batch.
2. Upload the ZIP of PDF, PNG, JPG or JPEG certificates. Inspect the numbered ZIP-position list.
3. Upload a UTF-8 CSV with a header row and two columns: `name,email`. `names,gmails` and common name/email aliases are also recognized. For unfamiliar headers, select just the name and email columns.
4. CertFlow automatically pairs the first CSV data row with the first certificate, the second row with the second certificate, and so on. No filename, name, email-username, certificate-ID or fuzzy matching is performed. Extra certificate-reference columns are ignored.
5. Review the paired recipient list. Counts must be equal, every ZIP entry shown as a certificate must be valid, and invalid or duplicate email rows remain blocked until corrected or explicitly skipped.
6. Customize the email, preview the personalized content and attachment, and send one explicitly confirmed test.
7. Confirm the final batch and send. Progress, pause/stop and CSV/JSON exports work as before.

Example CSV:

```csv
name,email
First Recipient,first@example.com
Second Recipient,second@example.com
```

**Order means the ZIP archive's stored entry order**, not alphabetical, natural-number or file-browser sorting. CertFlow does not sort certificates. Folders and hidden/system entries are ignored; unsupported or corrupt visible files block pairing rather than being discarded and shifting later recipients. The numbered certificate list is authoritative. CSV rows retain their original order (excluding the header and empty lines). Repeated filenames in different folders are allowed because each entry has its own attachment ID.

Sorting or filtering the review table only changes its display: CSV row numbers and attachment assignments remain fixed. Skipping an invalid recipient leaves all later assignments intact. A successful upload does not prove the documents belong to the listed recipients; inspect the pairs before confirming.

## Ordered pairing, duplicates, and retry semantics

Counts must agree before any records are paired. Invalid certificate entries block the entire pairing operation. Invalid recipient rows keep their positions and are blocked individually. Uploaded certificate bytes are checked again against their approved SHA-256 fingerprints immediately before MIME generation.

Local duplicate checks compare recipient email and certificate filename or SHA-256 hash against sent/uncertain records. The user must select Skip or Send Again for a possible duplicate. Local history is browser-specific and can be lost, cleared, edited, or unavailable; it is not an exactly-once or cross-device guarantee. Imported history is validated, bounded and merged without downgrading existing sent records.

Only confirmed temporary rate-limit rejections receive automatic retries, with bounded exponential backoff and a capped `Retry-After`. Permanent errors are not repeatedly retried. A network timeout, ambiguous successful response or server-side Gmail error is marked **unknown** because Gmail might already have accepted the message. Verify Gmail Sent manually before starting a new reviewed batch for those records. The application has no mailbox-read scope to reconcile them automatically.

After completion/stopping/expiry, attachments are deleted, including when some messages failed. **Retry Failed** creates a fresh draft with only confirmed failures. Download the retry CSV, prepare a ZIP containing only those failed recipients' certificates in exactly the same order, then review, test and confirm again. Do not reuse the full original ZIP with a shorter retry CSV. Uncertain deliveries are excluded. This is intentionally safer than retaining attachments indefinitely or claiming durable server recovery.

## Storage and security model

- Browser localStorage: settings and versioned batch summaries (names, addresses, filenames, hashes, delivery statuses, Gmail IDs, timestamps and errors). No OAuth tokens, credentials or certificate bytes. IndexedDB is unnecessary because original files are not retained client-side.
- Backend: signed, random session identifiers in HTTP-only cookies; OAuth tokens, CSV rows and current batch metadata in temporary process memory; temporary upload files in a private OS temp directory.
- Production cookies: HTTPS-only, `__Host-` prefix, host-only, Path `/`, HttpOnly. OAuth uses state, PKCE, verified ID tokens and session rotation.
- Mutations: exact-origin and per-session CSRF checks, authentication, Zod schemas, rate limiting and session/batch locks.
- Socket.IO: authenticated cookie, CSRF token and origin validation; per-session rooms prevent cross-user event disclosure.
- ZIP: lazy/streamed extraction, generated disk filenames, traversal/backslash/symlink checks, declared and actual size limits, compression-ratio limits, CRC-32 checks, magic-byte MIME checks, PDF parsing, and image decoding. Uploaded data is never executed.
- ZIP and CSV uploads have no application-level aggregate size or batch-count caps by default. Optional Render environment variables `MAX_ZIP_MB`, `MAX_CSV_MB`, `MAX_EXPANDED_MB`, `MAX_ZIP_ENTRIES`, `MAX_CERTIFICATES`, and `MAX_RECIPIENTS` accept nonnegative limits; unset or `0` disables that cap. Restart after changing them. The 15 MB per-certificate limit, 200:1 compression limit, CSV field/header validation, file integrity checks, authentication and upload locking remain active. This does not provide infinite capacity: RAM, temporary disk, browser storage, hosting request/time limits and Gmail quotas still apply. CSV parsing and batch metadata use memory; very large batches can exhaust the server. Set finite caps appropriate to your hosting capacity when needed. Browser history retains a 20 MB import/serialization guard and browser storage quotas; export active batch reports if local history cannot be saved.
- Only one Gmail request is in flight per batch; delay defaults to 1.5 seconds. Retry count is configurable from 0–5; delay from 1–60 seconds. Gmail account/project sending quotas still apply.
- Subject and sender name reject newlines. Nodemailer constructs multipart MIME with exactly one To address and one real attachment; no CC/BCC. Content is base64url encoded and sent through the Gmail API, never SMTP.
- Previews use a sandboxed iframe with no script capability. Template substitutions are HTML-escaped. CSV report exports neutralize formula-leading cells; this is an explicit export-only spreadsheet-safety measure, not a change to original recipient data.
- Sessions expire after eight hours; inactive batch files expire after two hours. Sending batches have an eight-hour ceiling. The reaper runs once per minute. Graceful shutdown stops work and removes temporary files. A hard platform termination destroys process state; the platform's ephemeral filesystem is not a recovery mechanism.
- Passwords, OAuth tokens and client secrets are never logged by application code. Do not enable platform request-body/debug logging for sensitive routes.

## Tests and verification

```sh
npm test
npm run build
npm audit --omit=dev
```

The test suite covers CSV parsing/aliases/quoting/limits, email syntax, duplicate detection, ordered pairing, count mismatches, invalid entries without positional shifts, real ZIP extraction, traversal and symlink rejection, ZIP bombs, corrupt files, HTML escaping, MIME attachments, Gmail response classification, sequential delivery, retry/backoff, pause/resume/stop, local history, CSV formula protection, authenticated API validation, CSRF, single-test idempotency and final-send gates. Gmail is mocked only through dependency injection in tests. The production entrypoint always uses the real Gmail adapter.

Sample certificates, recipient lists, and their generator are included only in the downloadable archive; they are omitted from this public repository. Use certificate files and recipient addresses you control.

### Production acceptance test (requires your accounts)

1. Connect a Google test-user account on the actual deployed URL.
2. Replace the example recipient addresses with three addresses you control. Upload the sample ZIP and edited CSV; verify the three ordered pairs.
3. Inspect each certificate and preview. Send one test to yourself and verify Gmail received the HTML and correct downloadable PDF.
4. Confirm the bulk batch and verify three individually addressed messages, each with its own certificate. Check Gmail message IDs in the report.
5. Run the invalid CSV scenario; confirm invalid/duplicate/missing records cannot be sent.
6. Use a larger controlled batch to exercise pause/resume/stop; confirm stop removes attachments and preserves sent metadata.
7. Export history, import it in another browser, and verify duplicate warnings on a new matching batch.
8. Check narrow/mobile layouts, theme settings, keyboard navigation and email rendering in your actual target clients (Gmail, Outlook, Apple Mail, Yahoo).
9. Restart Render and verify reauthentication/reupload is required while local history remains available.

Live Google OAuth, delivery to real mailboxes, hosting behavior and Outlook/Apple Mail/Yahoo rendering require this acceptance pass. Automated tests cannot certify those external systems. Do not describe the app as independently security-audited or delivery-guaranteed.

## API

All batch/email routes require the authenticated cookie. Every mutation also requires the exact `Origin` and `X-CSRF-Token` from `/api/auth/me`. Errors return safe JSON messages without stack traces.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/auth/me` | Account, CSRF token and setup state |
| GET | `/api/auth/google` | Start backend OAuth |
| GET | `/api/auth/google/callback` | Validate state, exchange code, rotate session |
| POST | `/api/auth/logout` | Revoke authorization and clear temporary state |
| POST | `/api/batch/new` | Create a temporary batch |
| POST | `/api/batch/upload-zip` | Multipart `file` ZIP upload |
| POST | `/api/batch/upload-csv` | Multipart `file` CSV upload |
| POST | `/api/batch/analyze` | Current analysis results |
| POST | `/api/batch/pair` | Pair by ZIP/CSV order using name/email columns and local duplicate advisory |
| POST | `/api/batch/record` | Skip a recipient or confirm a duplicate resend |
| GET | `/api/batch/attachment/:id` | Download a validated certificate |
| POST | `/api/email/template` | Save template and invalidate previous test |
| POST | `/api/email/preview` | Actual personalized HTML and envelope |
| POST | `/api/email/test` | One explicit test, with request-id guard |
| POST | `/api/batch/send` | Start only a tested, reviewed batch revision |
| POST | `/api/batch/pause` | Pause after current in-flight message |
| POST | `/api/batch/resume` | Resume an in-memory active batch |
| POST | `/api/batch/stop` | Confirmed stop and cleanup |
| POST | `/api/batch/retry` | Explain expired-attachment recovery; UI creates a fresh retry batch |
| GET | `/api/batch/status` | Authoritative current process state |

## Project map

```text
certflow/
  frontend/
    src/                 React UI, API client, validated local history
    test/                Local history and report tests
    .env.example
    vercel.json
    vite.config.ts
  backend/
    src/                 OAuth, APIs, ZIP/CSV, ordered pairing, MIME, Gmail, worker
    test/                Core, Gmail adapter and authenticated API tests
    .env.example
  examples/              Three sample PDFs in a ZIP and CSV scenarios
  scripts/               Sample generation and Vercel proxy configuration
  render.yaml
  package.json
  package-lock.json
  .env.example
  .gitignore
  README.md
```

## Troubleshooting

- **Gmail sign-in is not configured:** set all three Google environment variables on the backend, not Vercel frontend variables.
- **redirect_uri_mismatch:** compare the exact URI in Google Console with `GOOGLE_REDIRECT_URI`. In proxy mode both use the frontend hostname.
- **Login returns to a disconnected workspace:** check cookies, proxy destinations, `FRONTEND_URL`, HTTPS and `COOKIE_SAME_SITE`. Direct cross-site deployments may be blocked by the browser; use proxy or same-site domains.
- **Connection interrupted:** inspect `/api/health`; Render may be starting or restarting. Do not blindly repeat a send request. Reconcile current batch status and Gmail Sent.
- **Test required after an edit:** pairing, skipping and template changes invalidate the tested revision. Complete those changes before the final test.
- **Attachments expired / Retry Failed:** upload only the failed recipients' certificates in the retry CSV's order into the new batch. No permanent server archive exists.
- **History storage full:** export current reports and raw history from Settings, then clear older local history. Storage failures are surfaced in the UI.
- **A session or batch disappears after deployment:** expected with in-memory operation. Reconnect, export existing local history and start a reviewed new batch. Do not assume unfinished recipients were never sent.

