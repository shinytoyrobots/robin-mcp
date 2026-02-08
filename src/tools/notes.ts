import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db.js";

export function registerNoteTools(server: McpServer): void {
  server.tool(
    "create-note",
    "Create a new note with title, content, and optional tags",
    {
      title: z.string().describe("Note title"),
      content: z.string().describe("Note content (markdown supported)"),
      tags: z
        .string()
        .optional()
        .describe("Comma-separated tags, e.g. 'javascript,react,notes'"),
    },
    async ({ title, content, tags }) => {
      const db = getDb();
      const result = db
        .prepare(
          "INSERT INTO notes (title, content, tags) VALUES (?, ?, ?)"
        )
        .run(title, content, tags || "");

      const note = db
        .prepare("SELECT * FROM notes WHERE id = ?")
        .get(result.lastInsertRowid) as Record<string, unknown>;

      return {
        content: [
          {
            type: "text" as const,
            text: `Note created (id: ${note.id}):\n\nTitle: ${note.title}\nTags: ${note.tags || "(none)"}\nCreated: ${note.created_at}\n\n${note.content}`,
          },
        ],
      };
    }
  );

  server.tool(
    "search-notes",
    "Search notes using full-text search or filter by tag",
    {
      query: z
        .string()
        .optional()
        .describe("Full-text search query"),
      tag: z
        .string()
        .optional()
        .describe("Filter by tag"),
    },
    async ({ query, tag }) => {
      const db = getDb();
      let notes: Record<string, unknown>[];

      if (query) {
        notes = db
          .prepare(
            `SELECT notes.* FROM notes_fts
             JOIN notes ON notes.id = notes_fts.rowid
             WHERE notes_fts MATCH ?
             ORDER BY rank`
          )
          .all(query) as Record<string, unknown>[];
      } else if (tag) {
        notes = db
          .prepare(
            "SELECT * FROM notes WHERE ',' || tags || ',' LIKE ? ORDER BY updated_at DESC"
          )
          .all(`%,${tag},%`) as Record<string, unknown>[];
      } else {
        notes = db
          .prepare("SELECT * FROM notes ORDER BY updated_at DESC LIMIT 50")
          .all() as Record<string, unknown>[];
      }

      if (notes.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No notes found." }],
        };
      }

      const summary = notes
        .map(
          (n) =>
            `[${n.id}] ${n.title} (tags: ${n.tags || "none"}) - updated ${n.updated_at}`
        )
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${notes.length} note(s):\n\n${summary}`,
          },
        ],
      };
    }
  );

  server.tool(
    "get-note",
    "Retrieve a note by its ID",
    {
      id: z.number().describe("Note ID"),
    },
    async ({ id }) => {
      const db = getDb();
      const note = db
        .prepare("SELECT * FROM notes WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;

      if (!note) {
        return {
          content: [
            { type: "text" as const, text: `Note with id ${id} not found.` },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `# ${note.title}\n\nID: ${note.id}\nTags: ${note.tags || "(none)"}\nCreated: ${note.created_at}\nUpdated: ${note.updated_at}\n\n${note.content}`,
          },
        ],
      };
    }
  );

  server.tool(
    "update-note",
    "Update an existing note's title, content, or tags",
    {
      id: z.number().describe("Note ID to update"),
      title: z.string().optional().describe("New title"),
      content: z.string().optional().describe("New content"),
      tags: z.string().optional().describe("New comma-separated tags"),
    },
    async ({ id, title, content, tags }) => {
      const db = getDb();
      const existing = db
        .prepare("SELECT * FROM notes WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;

      if (!existing) {
        return {
          content: [
            { type: "text" as const, text: `Note with id ${id} not found.` },
          ],
          isError: true,
        };
      }

      const newTitle = title ?? existing.title;
      const newContent = content ?? existing.content;
      const newTags = tags ?? existing.tags;

      db.prepare(
        "UPDATE notes SET title = ?, content = ?, tags = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newTitle, newContent, newTags, id);

      return {
        content: [
          {
            type: "text" as const,
            text: `Note ${id} updated successfully.`,
          },
        ],
      };
    }
  );

  server.tool(
    "delete-note",
    "Delete a note by its ID",
    {
      id: z.number().describe("Note ID to delete"),
    },
    async ({ id }) => {
      const db = getDb();
      const result = db
        .prepare("DELETE FROM notes WHERE id = ?")
        .run(id);

      if (result.changes === 0) {
        return {
          content: [
            { type: "text" as const, text: `Note with id ${id} not found.` },
          ],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text" as const, text: `Note ${id} deleted.` },
        ],
      };
    }
  );
}
