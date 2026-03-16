# robin-mcp

## Identity
URI prefix: `robin://` (not `personal://`)
Server name from package.json description.

## Auth Model
- AUTH_TOKEN: full access (read + write + adapter tools)
- READONLY_TOKEN: native tools only, no adapters
- Adapter tools use Robin's personal credentials server-side — restrict to full-access sessions

## Adapter Gotchas
- google-mcp-server crashes (nil pointer) if DISABLE_SHEETS/SLIDES/CALENDAR/GMAIL are not set in multi-account mode
- Must create default token at `~/.google-mcp-token.json` (bare OAuth2 token, not account wrapper)
- If Google tokens expire: run `accounts_add` locally with DISABLE_DOCS=true, then update Railway env var

## MCP Client Connection
Connect via `mcp-remote` to Railway HTTP endpoint. Never add a local stdio override — it causes writes to hang silently.

## Google Calendar Reauth
If the gcal proxy returns 500 (token refresh fails), the `GOOGLE_REFRESH_TOKEN` has expired.
1. Run `npm run reauth:gcal` locally — opens browser OAuth flow, prints new token
2. Update Railway: `railway variables set GOOGLE_REFRESH_TOKEN="<token>" --service zesty-stillness`
3. Redeploy: `git commit --allow-empty -m 'trigger redeploy: gcal reauth' && git push`

## Commands
- Build: `npm run build` (tsc + copies dashboard views)
- Dev (stdio): `npm run dev:stdio`
- Dev (HTTP): `npm run dev:http`
- Inspect: `npm run inspect`
- Reauth gcal: `npm run reauth:gcal`
