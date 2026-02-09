import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

export const config = {
  dbPath: process.env.DB_PATH || "./data/robin.db",
  websiteUrl: process.env.WEBSITE_URL || "",
  rssFeedUrl: process.env.RSS_FEED_URL || "",
  linkedinUrl: process.env.LINKEDIN_URL || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  linearApiKey: process.env.LINEAR_API_KEY || "",
  vaultRepo: process.env.VAULT_REPO || "",
  httpPort: parseInt(process.env.HTTP_PORT || "3001", 10),
  authToken: process.env.AUTH_TOKEN || "",
  readonlyToken: process.env.READONLY_TOKEN || "",
};
