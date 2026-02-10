#!/bin/sh
# Write Google OAuth tokens from env vars to disk before starting the server.
# google-mcp-server expects tokens at ~/.google-mcp-accounts/<email>.json

ACCOUNTS_DIR="$HOME/.google-mcp-accounts"
mkdir -p "$ACCOUNTS_DIR"

if [ -n "$GOOGLE_TOKEN_PERSONAL" ]; then
  echo "$GOOGLE_TOKEN_PERSONAL" > "$ACCOUNTS_DIR/robin_cannon_at_gmail_com.json"
  echo "Wrote personal Google token"
fi

if [ -n "$GOOGLE_TOKEN_WORK" ]; then
  echo "$GOOGLE_TOKEN_WORK" > "$ACCOUNTS_DIR/robin_at_knapsack_cloud.json"
  echo "Wrote work Google token"
fi

# Create a default token so google-mcp-server has a non-nil OAuth client
# (needed for Docs service which doesn't guard against nil in multi-account mode).
# Account tokens have a wrapper {email,token,...}; the default token file must be
# a bare OAuth2 token {access_token, refresh_token, ...}.
DEFAULT_TOKEN="$HOME/.google-mcp-token.json"
if [ -n "$GOOGLE_TOKEN_PERSONAL" ] && [ ! -f "$DEFAULT_TOKEN" ]; then
  node -e "const t=JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify(t.token||t))" "$GOOGLE_TOKEN_PERSONAL" > "$DEFAULT_TOKEN"
  echo "Wrote default Google token"
fi

exec node dist/http.js
