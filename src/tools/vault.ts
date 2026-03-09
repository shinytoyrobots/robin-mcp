import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";

interface GitHubContent {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
}

export function encodeRepoPath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

export async function githubApiGet(endpoint: string): Promise<Response> {
  return fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${config.githubToken}`,
      "User-Agent": "robin-mcp",
    },
  });
}

async function githubApiWrite(
  method: "PUT" | "DELETE",
  endpoint: string,
  body: object
): Promise<Response> {
  return fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${config.githubToken}`,
      "User-Agent": "robin-mcp",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function vaultGetFileSha(filePath: string): Promise<string | null> {
  const response = await githubApiGet(
    `/repos/${config.vaultRepo}/contents/${encodeRepoPath(filePath)}`
  );
  if (!response.ok) return null;
  const data = (await response.json()) as { sha?: string };
  return data.sha ?? null;
}

export async function vaultWriteFile(
  filePath: string,
  content: string,
  commitMessage?: string
): Promise<{ created: boolean }> {
  const sha = await vaultGetFileSha(filePath);
  const body: Record<string, unknown> = {
    message: commitMessage ?? `note: update ${filePath}`,
    content: Buffer.from(content, "utf-8").toString("base64"),
    committer: { name: "robin-mcp", email: "robin-mcp@users.noreply.github.com" },
  };
  if (sha) body.sha = sha;

  const response = await githubApiWrite(
    "PUT",
    `/repos/${config.vaultRepo}/contents/${encodeRepoPath(filePath)}`,
    body
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to write ${filePath}: ${response.status} ${err}`);
  }
  invalidateVaultTreeCache();
  return { created: !sha };
}

export async function vaultDeleteFile(filePath: string, commitMessage?: string): Promise<void> {
  const sha = await vaultGetFileSha(filePath);
  if (!sha) throw new Error(`File not found: ${filePath}`);

  const response = await githubApiWrite(
    "DELETE",
    `/repos/${config.vaultRepo}/contents/${encodeRepoPath(filePath)}`,
    {
      message: commitMessage ?? `note: delete ${filePath}`,
      sha,
      committer: { name: "robin-mcp", email: "robin-mcp@users.noreply.github.com" },
    }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to delete ${filePath}: ${response.status} ${err}`);
  }
  invalidateVaultTreeCache();
}

const WRITABLE_PREFIXES = ["Notes/", "AI Guidance/"];

export function assertWritablePath(filePath: string): void {
  if (!WRITABLE_PREFIXES.some((p) => filePath.startsWith(p))) {
    throw new Error(
      `Path "${filePath}" is not writable. Only Notes/ and AI Guidance/ are permitted.`
    );
  }
}

async function listTree(dirPath: string): Promise<string> {
  const response = await githubApiGet(
    `/repos/${config.vaultRepo}/contents/${encodeRepoPath(dirPath)}`
  );
  if (!response.ok) {
    return `  (error listing ${dirPath}: ${response.status})`;
  }
  const items = (await response.json()) as GitHubContent[];
  const lines: string[] = [];

  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith(".")) continue;
    if (item.type === "dir") {
      lines.push(`${item.path}/`);
      const sub = await listTree(item.path);
      lines.push(sub);
    } else {
      lines.push(`${item.path}`);
    }
  }
  return lines.join("\n");
}

const VAULT_TREE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
let cachedVaultTree: string | null = null;
let vaultTreeCachedAt = 0;

export function invalidateVaultTreeCache(): void {
  cachedVaultTree = null;
  vaultTreeCachedAt = 0;
}

const MAX_VAULT_FILE_SIZE = 50_000;

export function registerVaultTools(server: McpServer): void {
  if (!config.vaultRepo || !config.githubToken) return;

  // Resource: vault structure overview (cached)
  server.resource(
    "creative-vault",
    "robin://vault/structure",
    { description: `File structure of the ${config.vaultRepo} creative vault` },
    async (uri) => {
      const now = Date.now();
      if (!cachedVaultTree || now - vaultTreeCachedAt > VAULT_TREE_CACHE_TTL_MS) {
        cachedVaultTree = await listTree("");
        vaultTreeCachedAt = now;
      }
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/plain",
            text: `# Creative Vault: ${config.vaultRepo}\n\n${cachedVaultTree}`,
          },
        ],
      };
    }
  );

  // Tool: read a specific file from the vault
  server.tool(
    "vault-read-file",
    `Read a file from the ${config.vaultRepo} creative vault`,
    {
      path: z
        .string()
        .describe("File path within the repo, e.g. 'Fiction/StaticDrift/chapter1.md'"),
    },
    async ({ path: filePath }) => {
      const response = await githubApiGet(
        `/repos/${config.vaultRepo}/contents/${encodeRepoPath(filePath)}`
      );

      if (!response.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not read ${filePath}: ${response.status} ${response.statusText}`,
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as {
        type: string;
        content?: string;
        encoding?: string;
        name: string;
        path: string;
        size: number;
      };

      if (data.type !== "file" || !data.content) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${filePath} is a directory, not a file. Use the creative-vault resource to see the structure.`,
            },
          ],
          isError: true,
        };
      }

      let text = Buffer.from(data.content, "base64").toString("utf-8");
      if (text.length > MAX_VAULT_FILE_SIZE) {
        text = text.slice(0, MAX_VAULT_FILE_SIZE) + "\n\n...(truncated, file exceeds 50KB)";
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `# ${data.name}\n\nPath: ${data.path}\nSize: ${data.size} bytes\n\n---\n\n${text}`,
          },
        ],
      };
    }
  );

  // Tool: list files in a vault directory
  server.tool(
    "vault-list-dir",
    `List files in a directory of the ${config.vaultRepo} creative vault`,
    {
      path: z
        .string()
        .optional()
        .default("")
        .describe("Directory path within the repo (empty for root)"),
    },
    async ({ path: dirPath }) => {
      const response = await githubApiGet(
        `/repos/${config.vaultRepo}/contents/${encodeRepoPath(dirPath)}`
      );

      if (!response.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not list ${dirPath || "/"}: ${response.status} ${response.statusText}`,
            },
          ],
          isError: true,
        };
      }

      const items = (await response.json()) as GitHubContent[];
      const listing = items
        .filter((i) => !i.name.startsWith("."))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((i) => `${i.type === "dir" ? "📁" : "📄"} ${i.name}`)
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Contents of ${dirPath || "/"}:\n\n${listing}`,
          },
        ],
      };
    }
  );

  // Tool: write (create or update) a file in the vault — restricted to Notes/ and AI Guidance/
  server.tool(
    "vault-write-file",
    `Write (create or update) a markdown file in the ${config.vaultRepo} vault. Only paths under Notes/ or AI Guidance/ are writable.`,
    {
      path: z
        .string()
        .describe("File path within the repo (must start with Notes/ or AI Guidance/)"),
      content: z.string().describe("Full file content (markdown)"),
      commitMessage: z
        .string()
        .optional()
        .describe("Git commit message (defaults to 'note: update {path}')"),
    },
    async ({ path: filePath, content, commitMessage }) => {
      try {
        assertWritablePath(filePath);
        const { created } = await vaultWriteFile(filePath, content, commitMessage);
        return {
          content: [
            {
              type: "text" as const,
              text: `${created ? "Created" : "Updated"} ${filePath}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: String(err) }],
          isError: true,
        };
      }
    }
  );
}
