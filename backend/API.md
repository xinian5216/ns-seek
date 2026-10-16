# Backend API

Fixed public origin: `https://ns.042804.xyz:8443`. Backend listens only on `127.0.0.1:18765`; the reverse proxy overwrites Host accordingly. No native cross-origin CORS. No Cookie from NodeSeek is accepted or required.

- `GET /health`: public service identifier/version only.
- `POST /auth/login {password}`: scrypt verification, five attempts/minute globally, eight-hour Secure HttpOnly SameSite=Strict session.
- `POST /auth/password {currentPassword,newPassword}`: panel session; 24–128 printable ASCII with upper/lower/digit/symbol. Atomically rotates all three API keys and password hash, revokes old sessions and pairing codes; returns a replacement session. Never returns the password or API keys.
- `POST /auth/logout {}`: removes current panel session only; paired API keys remain valid.
- `GET /local/status`: panel session; archive statistics, never credentials.
- `POST /local/pair {}`: panel session; five-minute single-use pairing code.
- `POST /pair/claim {code}`: exchanges code for separate query/sync Bearer tokens; never admin token.
- `GET /v1/status`: query or sync token; retained counts and progress.
- `GET /v1/sync-plan`: sync token; descending `nextId`, `latestId`, retention boundary state. `nextId=0` means current scan stopped, never proof of completeness.
- `POST /v1/ingest`: sync token; `{kind:'page'|'id',records:[...],requestedId?,page?,lastPage?}`. Up to 20 white-listed records. Server discards ordinary/expired events and stores numeric observation checkpoints only. Empty ID is checkpointed only after successful forum response. Descending scan stops after 20 consecutive valid expired records; empty IDs reset this streak.
- `GET /v1/user?uid=N&before=N&limit=50`: query token; keyset pagination, limit 1–100. Only ban/unban events within the last 365 days. Query does not update or log search history.

`/local/open`, `/local/stop`, `/local/session` are local control routes and are blocked by Caddy on the public endpoint. All unknown paths fail closed. Static assets are an explicit three-file allowlist, never a filesystem directory server.

Password hashes and keys persist privately; browser sessions/codes do not survive restart. Hourly cleanup physically removes expired rows with secure_delete and WAL truncation; requests filter expiry immediately. Database/provider snapshots are not encrypted or managed by this application.
