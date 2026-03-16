/**
 * Google Calendar OAuth reauth script.
 *
 * Usage:  npx tsx scripts/gcal-reauth.ts
 *
 * Opens the browser to Google's consent screen, captures the auth code via a
 * local callback server, exchanges it for tokens, and prints the new
 * GOOGLE_REFRESH_TOKEN ready to paste into Railway.
 *
 * Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (or env vars).
 */

import dotenv from "dotenv";
import { createServer } from "http";
import { URL } from "url";
import { exec } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent"); // forces new refresh token

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h2>Auth failed</h2><p>${error || "No code received"}</p>`);
    server.close();
    process.exit(1);
  }

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString(),
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenRes.ok || tokenData.error) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h2>Token exchange failed</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
    server.close();
    process.exit(1);
  }

  if (!tokenData.refresh_token) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<h2>No refresh token returned</h2>` +
      `<p>Google only returns a refresh token on the first authorization or when prompt=consent is set. ` +
      `Try revoking access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> first.</p>`
    );
    server.close();
    process.exit(1);
  }

  // Success
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    `<h2>Success!</h2>` +
    `<p>Refresh token obtained. Check your terminal for the next steps.</p>` +
    `<p>You can close this tab.</p>`
  );

  console.log("\n========================================");
  console.log("  New GOOGLE_REFRESH_TOKEN obtained");
  console.log("========================================\n");
  console.log(tokenData.refresh_token);
  console.log("\n--- Next steps ---");
  console.log("1. Update Railway env var:");
  console.log(`   railway variables set GOOGLE_REFRESH_TOKEN="${tokenData.refresh_token}" --service zesty-stillness`);
  console.log("\n2. Also update your local .env if desired.");
  console.log("\n3. Redeploy (env var changes don't auto-deploy):");
  console.log("   git commit --allow-empty -m 'trigger redeploy: gcal reauth' && git push");
  console.log("");

  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`\nListening on http://localhost:${PORT}/callback`);
  console.log(`\nOpening browser for Google OAuth consent...\n`);

  const openCmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" : "xdg-open";

  exec(`${openCmd} "${authUrl.toString()}"`);
});
