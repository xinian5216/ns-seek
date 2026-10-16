# Maintenance rules

- Keep this userscript independently maintained. Do not automatically merge or execute upstream scripts.
- Keep all runtime code in ns-seek.user.js; no runtime packages, remote scripts, analytics, remote icons or secrets.
- Only query after explicit consent. Never read cookies, persist query history, batch-query users or auto-retry requests.
- Preserve the fixed API allowlist, anonymous requests, empty Referer, redirect rejection and UID-only query.
- Treat all API and page text as untrusted. Use textContent and validated canonical post links.
- Keep original MIT attribution. Do not infer the upstream author's identity.
- Use synthetic fixtures. Never commit cookies, tokens, HAR files, real query records, local paths or personal email addresses.
- Keep update URLs under this repository. Bump package and userscript versions together; run npm run build.
- Before publishing: npm run check, npm test, dependency audit, Gitleaks on tracked files and all Git refs; inspect commit identities.
- Clearly distinguish mock DOM tests from actual Tampermonkey/browser verification. Do not claim end-to-end verification without evidence.
