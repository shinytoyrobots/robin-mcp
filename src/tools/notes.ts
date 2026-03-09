import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import {
  encodeRepoPath,
  githubApiGet,
  vaultGetFileSha,
  vaultWriteFile,
  vaultDeleteFile,
} from "./vault.js";

const NOTES_DIR = "Notes/Reference";

function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function buildFrontmatter(title: string, tags: string, created: string): string {
  return `---\ntitle: ${title}\ntags: ${tags}\ncreated: ${created}\n---\n\n`;
}

function parseFrontmatter(text: string): {
  title?: string;
  tags?: string;
  created?: string;
  body: string;
} {
  // Only split on the first two --- occurrences to handle --- inside body
  const firstClose = text.indexOf("\n---\n", 4);
  if (!text.startsWith("---\n") || firstClose === -1) return { body: text };
  const fm = text.slice(4, firstClose);
  const body = text.slice(firstClose + 5);
  const title = fm.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  const tags = fm.match(/^tags:\s*(.+)$/m)?.[1]?.trim();
  const created = fm.match(/^created:\s*(.+)$/m)?.[1]?.trim();
  return { title, tags, created, body };
}

function normalizePath(path: string): string {
  if (path.startsWith("Notes/") || path.startsWith("AI Guidance/")) return path;
  const withExt = path.endsWith(".md") ? path : `${path}.md`;
  return `${NOTES_DIR}/${withExt}`;
}

interface VaultDirItem {
  name: string;
  path: string;
  type: "file" | "dir";
}

async function readVaultFileText(filePath: string): Promise<string | null> {
  const response = await githubApiGet(
    `/repos/${config.vaultRepo}/contents/${encodeRepoPath(filePath)}`
  );
  if (!response.ok) return null;
  const data = (await response.json()) as { type: string; content?: string };
  if (data.type !== "file" || !data.content) return null;
  return Buffer.from(data.content, "base64").toString("utf-8");
}

async function listNoteFiles(): Promise<VaultDirItem[]> {
  const response = await githubApiGet(
    `/repos/${config.vaultRepo}/contents/${encodeRepoPath(NOTES_DIR)}`
  );
  if (!response.ok) return [];
  const items = (await response.json()) as VaultDirItem[];
  return items.filter((i) => i.type === "file" && i.name.endsWith(".md"));
}

export function registerNoteTools(server: McpServer, readOnly = false): void {
  if (!config.vaultRepo || !config.githubToken) return;

  if (!readOnly) {
    server.tool(
      "create-note",
      `Create a new note in the vault under ${NOTES_DIR}/`,
      {
        title: z.string().describe("Note title (used to generate the filename)"),
        content: z.string().describe("Note content (markdown)"),
        tags: z
          .string()
          .optional()
          .describe("Comma-separated tags, e.g. 'ideas,reference'"),
      },
      async ({ title, content, tags }) => {
        const slug = titleToSlug(title);
        if (!slug) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Could not generate a valid filename from that title.",
              },
            ],
            isError: true,
          };
        }

        let filePath = `${NOTES_DIR}/${slug}.md`;
        // Avoid overwriting an existing note — append timestamp if slug collides
        const existingSha = await vaultGetFileSha(filePath);
        if (existingSha) {
          filePath = `${NOTES_DIR}/${slug}-${Math.floor(Date.now() / 1000)}.md`;
        }

        const fullContent = buildFrontmatter(title, tags ?? "", today()) + content;
        try {
          await vaultWriteFile(filePath, fullContent, `note: create ${slug}`);
          return {
            content: [{ type: "text" as const, text: `Note created at ${filePath}` }],
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

  server.tool(
    "search-notes",
    `Search notes in the vault under ${NOTES_DIR}/`,
    {
      query: z.string().optional().describe("Text to search for in title or content"),
      tag: z.string().optional().describe("Filter by tag"),
      limit: z.number().optional().default(20).describe("Max results to return (default 20)"),
    },
    async ({ query, tag, limit }) => {
      const files = await listNoteFiles();
      if (files.length === 0) {
        return { content: [{ type: "text" as const, text: "No notes found." }] };
      }

      // No filter: return filenames only (fast, no per-file fetch)
      if (!query && !tag) {
        const listing = files
          .slice(0, limit)
          .map((f) => f.path)
          .join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `Notes in ${NOTES_DIR} (${Math.min(files.length, limit)} of ${files.length}):\n\n${listing}`,
            },
          ],
        };
      }

      // With filter: fetch each file (cap at 50 to avoid rate limits)
      const toSearch = files.slice(0, 50);
      const results: string[] = [];

      for (const file of toSearch) {
        if (results.length >= limit) break;
        const text = await readVaultFileText(file.path);
        if (!text) continue;

        const { title, tags: fileTags, body } = parseFrontmatter(text);

        if (tag) {
          const tagList = (fileTags ?? "")
            .split(",")
            .map((t) => t.trim().toLowerCase());
          if (!tagList.includes(tag.toLowerCase())) continue;
        }

        if (query) {
          const needle = query.toLowerCase();
          const haystack = `${title ?? ""} ${body}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
        }

        results.push(
          `${file.path}${title ? ` — ${title}` : ""}${fileTags ? ` [${fileTags}]` : ""}`
        );
      }

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No matching notes found." }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} note(s):\n\n${results.join("\n")}`,
          },
        ],
      };
    }
  );

  server.tool(
    "get-note",
    "Read a note from the vault by path",
    {
      path: z
        .string()
        .describe(
          "Note path — bare filename ('my-note.md') or full path ('Notes/Reference/my-note.md')"
        ),
    },
    async ({ path }) => {
      const filePath = normalizePath(path);
      const text = await readVaultFileText(filePath);
      if (!text) {
        return {
          content: [{ type: "text" as const, text: `Note not found: ${filePath}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `# ${filePath}\n\n${text}` }],
      };
    }
  );

  if (!readOnly) {
    server.tool(
      "update-note",
      "Update a note's title, content, or tags",
      {
        path: z
          .string()
          .describe(
            "Note path — bare filename ('my-note.md') or full path ('Notes/Reference/my-note.md')"
          ),
        title: z.string().optional().describe("New title"),
        content: z.string().optional().describe("New body content (replaces existing)"),
        tags: z.string().optional().describe("New comma-separated tags"),
      },
      async ({ path, title, content, tags }) => {
        const filePath = normalizePath(path);
        const existing = await readVaultFileText(filePath);
        if (!existing) {
          return {
            content: [{ type: "text" as const, text: `Note not found: ${filePath}` }],
            isError: true,
          };
        }

        const parsed = parseFrontmatter(existing);
        const newTitle = title ?? parsed.title ?? "";
        const newTags = tags ?? parsed.tags ?? "";
        const newBody = content ?? parsed.body;
        const created = parsed.created ?? today();

        const fullContent = buildFrontmatter(newTitle, newTags, created) + newBody;
        try {
          await vaultWriteFile(filePath, fullContent, `note: update ${filePath}`);
          return {
            content: [{ type: "text" as const, text: `Note updated: ${filePath}` }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: String(err) }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "delete-note",
      "Delete a note from the vault",
      {
        path: z
          .string()
          .describe(
            "Note path — bare filename ('my-note.md') or full path ('Notes/Reference/my-note.md')"
          ),
      },
      async ({ path }) => {
        const filePath = normalizePath(path);
        try {
          await vaultDeleteFile(filePath, `note: delete ${filePath}`);
          return {
            content: [{ type: "text" as const, text: `Note deleted: ${filePath}` }],
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
}
