# Maintenance rules

- Keep this userscript independently maintained. Do not automatically merge or execute upstream scripts.
- Keep userscript runtime code in ns-seek.user.js, local service code in backend/. No runtime packages, remote scripts, analytics or embedded secrets.
- Query only after a user click. Archive synchronization requires an explicit start; never read/export forum cookies or persist query history. Public moderation records may be archived in the private SQLite store (only ban/unban events within the last 365 days, with automatic expiry) as authorized by the user.
- Forum collection must use same-origin fetch to fixed ruling page/id paths, browser-managed same-origin credentials, no Referer and redirect rejection. Never bypass login, browser challenges or rate limits; stop rather than automatically retry failures.
- Userscript cross-origin calls are restricted to the fixed HTTPS service at https://ns.042804.xyz:8443 using anonymous GM requests. Store paired query/sync credentials only in GM storage, never page DOM or URLs. No third-party fallback or arbitrary endpoint settings.
- Backend service must bind 127.0.0.1 only, validate Host and Origin, require scoped credentials, keep ingestion separate from read-only queries and never log tokens, URLs, record contents or local secrets. Pairing codes must be single-use and expire. Public access requires independent password authentication; store only scrypt password hashes. Password rotation must revoke every old session, pairing code and API key. Preserve the existing port 443 proxy.
- Collection is sequential with at least 1200ms after a completed request. Support cancellation and durable resume. The page list is capped at 100; historical ID probing is separately verified and must never claim complete historical coverage.
- Pairing must capture its fragment before the forum pagination router can replace it, initialize DOM only after readiness, and provide a manual one-use-code fallback. Navigate in the current tab instead of relying on popups. Progress reports may contain only fixed enums and numeric page/record IDs; keep them in memory, authenticated, and mark missing heartbeats as uncertain.
- Treat all API and page text as untrusted. Use textContent and validated canonical post links.
- Keep original MIT attribution. Do not infer the upstream author's identity.
- Use synthetic fixtures. Never commit cookies, tokens, HAR files, real query records, local paths or personal email addresses.
- Keep update URLs under this repository. Bump package and userscript versions together; run npm run build.
- Before publishing: npm run check, npm test, dependency audit, Gitleaks on tracked files and all Git refs; inspect commit identities.
- Clearly distinguish mock DOM tests from actual Tampermonkey/browser verification. Do not claim end-to-end verification without evidence.
