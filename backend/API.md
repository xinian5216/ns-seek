# Backend API

- Owner session only: `GET/POST /owner/notifications` reads redacted status or updates `{enabled,token?,chatId?,clear?}`. Empty credentials preserve stored values; positive numeric private chat IDs only. `POST /owner/notifications/test {}` sends a fixed test, at most once per minute. No stored credential is returned.
- `POST /owner/browser/open {}` pauses collection, starts the managed browser and enters manual control. Frames/actions renew a ten-minute manual idle lease. Enabling automation releases manual control; the browser sleeps after a batch.
- User lookup includes safe automation pause/overdue metadata. No notification credentials or browser access are added to query scope.

Fixed public origin: `https://ns.042804.xyz:8443`. Backend listens only on `127.0.0.1:18765`; the reverse proxy overwrites Host accordingly. No native cross-origin CORS. No Cookie from NodeSeek is accepted or required.

- `GET /health`: public service identifier/version only.
- `POST /auth/login {password}`: scrypt verification, five attempts/minute globally, eight-hour Secure HttpOnly SameSite=Strict session.
- `POST /auth/password {currentPassword,newPassword}`: panel session; 24–128 printable ASCII with upper/lower/digit/symbol. Atomically rotates all three API keys and password hash, revokes old sessions and pairing codes; returns a replacement session. Never returns the password or API keys.
- `POST /auth/logout {}`: removes current panel session only; paired API keys remain valid.
- `GET /local/status`: panel session; archive statistics, never credentials.
- `POST /local/pair {}`: panel session; five-minute single-use pairing code.
- `POST /pair/claim {code}`: exchanges code for separate query/sync Bearer tokens; never admin token.
- `GET /v1/status`: query or sync token; retained counts and progress.
- `POST /v1/progress`: sync token, `{state,stage,page?,recordId?,errorCode?}`; strict enums and numeric counters only. In-memory status, no error text or user data. Running heartbeat older than 45 seconds is marked stale. Password rotation clears it. Panel reads `sync` in authenticated status responses every five seconds.
- `GET /v1/sync-plan`: sync token; descending `nextId`, `latestId`, retention boundary state. `nextId=0` means current scan stopped, never proof of completeness.
- `POST /v1/ingest`: sync token; `{kind:'page'|'id',records:[...],requestedId?,page?,lastPage?}`. Up to 20 white-listed records. Server discards ordinary/expired events and stores numeric observation checkpoints only. Empty ID is checkpointed only after successful forum response. Descending scan stops after 20 consecutive valid expired records; empty IDs reset this streak.
- `GET /v1/user?uid=N&before=N&limit=50`: query token; keyset pagination, limit 1–100. Only ban/unban events within the last 365 days. Query does not update or log search history.

`/local/open`, `/local/stop`, `/local/session` are local control routes and are blocked by Caddy on the public endpoint. All unknown paths fail closed. Static assets are an explicit three-file allowlist, never a filesystem directory server.

Password hashes and keys persist privately; browser sessions/codes do not survive restart. Hourly cleanup physically removes expired rows with secure_delete and WAL truncation; requests filter expiry immediately. Database/provider snapshots are not encrypted or managed by this application.

## Owner-only VPS browser and scheduler (1.3.0)

`NS_SEEK_BROWSER=1` enables the dedicated browser. No query, sync or admin Bearer token grants the following routes; a current same-origin panel session is required. The browser never reads desktop cookies or exposes arbitrary CDP/evaluation commands.

- `GET /browser`, `/browser.js`, `/browser.css`: authenticated UI. Unauthenticated `/browser` redirects to login.
- `GET /owner/browser/frame`: transient PNG screenshot, no-store; owner session rechecked after capture.
- `POST /owner/browser/action`: fixed navigate(home/ruling), click coordinates, wheel, text up to 4096 characters, or allowlisted keys. Only while automation is paused. No arbitrary URLs or evaluation. Input is transient, never logged.
- `POST /owner/automation/enable {}`: validate/collect via normal forum browser; enable persisted schedule.
- `POST /owner/automation/pause {}`: abort further ingestion and pause schedule.
- `/local/status` includes owner scheduler state, current stage and next run; `/v1/status` includes only availability, enabled and fixed blocked category.

Recent collection every six hours; historical batches up to 200 IDs, followed by a fifteen-minute continuation interval. Sequential >=1200ms after completed requests. Any login, challenge, rate, network, data or resource failure blocks subsequent scheduled requests until owner resume. Manual browser opening pauses automation. Application restart preserves schedule and block state; browser profile remains private.
