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

exec node dist/http.js
