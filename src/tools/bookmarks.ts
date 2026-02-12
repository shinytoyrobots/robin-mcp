import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db.js";

export function registerBookmarkTools(server: McpServer, readOnly = false): void {
  if (!readOnly) server.tool(
    "save-bookmark",
    "Save a URL as a bookmark with title, description, and tags",
    {
      url: z.string().url().describe("URL to bookmark"),
      title: z.string().describe("Bookmark title"),
      description: z
        .string()
        .optional()
        .describe("Description of the bookmarked page"),
      tags: z
        .string()
        .optional()
        .describe("Comma-separated tags"),
    },
    async ({ url, title, description, tags }) => {
      const db = getDb();
      try {
        db.prepare(
          "INSERT INTO bookmarks (url, title, description, tags) VALUES (?, ?, ?, ?)"
        ).run(url, title, description || "", tags || "");

        return {
          content: [
            {
              type: "text" as const,
              text: `Bookmark saved: ${title}\nURL: ${url}\nTags: ${tags || "(none)"}`,
            },
          ],
        };
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        if (message.includes("UNIQUE constraint")) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Bookmark for this URL already exists: ${url}`,
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    }
  );

  server.tool(
    "search-bookmarks",
    "Search bookmarks by keyword or tag",
    {
      query: z
        .string()
        .optional()
        .describe("Search keyword (matches title, description, URL)"),
      tag: z
        .string()
        .optional()
        .describe("Filter by tag"),
      limit: z.number().optional().default(20).describe("Max results to return (default 20)"),
      offset: z.number().optional().default(0).describe("Number of results to skip for pagination"),
    },
    async ({ query, tag, limit, offset }) => {
      const db = getDb();
      let bookmarks: Record<string, unknown>[];
      let total: number;

      if (query) {
        const like = `%${query}%`;
        total = (db.prepare(
          `SELECT COUNT(*) as count FROM bookmarks
           WHERE title LIKE ? OR description LIKE ? OR url LIKE ?`
        ).get(like, like, like) as { count: number }).count;
        bookmarks = db
          .prepare(
            `SELECT * FROM bookmarks
             WHERE title LIKE ? OR description LIKE ? OR url LIKE ?
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`
          )
          .all(like, like, like, limit, offset) as Record<string, unknown>[];
      } else if (tag) {
        total = (db.prepare(
          "SELECT COUNT(*) as count FROM bookmarks WHERE ',' || tags || ',' LIKE ?"
        ).get(`%,${tag},%`) as { count: number }).count;
        bookmarks = db
          .prepare(
            "SELECT * FROM bookmarks WHERE ',' || tags || ',' LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
          )
          .all(`%,${tag},%`, limit, offset) as Record<string, unknown>[];
      } else {
        total = (db.prepare(
          "SELECT COUNT(*) as count FROM bookmarks"
        ).get() as { count: number }).count;
        bookmarks = db
          .prepare(
            "SELECT * FROM bookmarks ORDER BY created_at DESC LIMIT ? OFFSET ?"
          )
          .all(limit, offset) as Record<string, unknown>[];
      }

      if (bookmarks.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No bookmarks found." },
          ],
        };
      }

      const summary = bookmarks
        .map(
          (b) =>
            `[${b.id}] ${b.title}\n    ${b.url}\n    Tags: ${b.tags || "none"}`
        )
        .join("\n\n");

      const showing = total > bookmarks.length
        ? `Showing ${offset + 1}–${offset + bookmarks.length} of ${total} bookmarks`
        : `Found ${total} bookmark(s)`;

      return {
        content: [
          {
            type: "text" as const,
            text: `${showing}:\n\n${summary}`,
          },
        ],
      };
    }
  );

  if (!readOnly) server.tool(
    "delete-bookmark",
    "Delete a bookmark by its ID",
    {
      id: z.number().describe("Bookmark ID to delete"),
    },
    async ({ id }) => {
      const db = getDb();
      const result = db
        .prepare("DELETE FROM bookmarks WHERE id = ?")
        .run(id);

      if (result.changes === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Bookmark with id ${id} not found.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text" as const, text: `Bookmark ${id} deleted.` },
        ],
      };
    }
  );
}
