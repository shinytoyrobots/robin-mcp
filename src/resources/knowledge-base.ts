import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db.js";

export function registerKnowledgeBaseResources(server: McpServer): void {
  server.resource(
    "all-tags",
    "robin://kb/tags",
    { description: "All tags across notes and bookmarks" },
    async (uri) => {
      const db = getDb();

      const noteTags = db
        .prepare("SELECT DISTINCT tags FROM notes WHERE tags != ''")
        .all() as Array<{ tags: string }>;
      const bookmarkTags = db
        .prepare("SELECT DISTINCT tags FROM bookmarks WHERE tags != ''")
        .all() as Array<{ tags: string }>;

      const tagSet = new Set<string>();
      for (const row of [...noteTags, ...bookmarkTags]) {
        for (const tag of row.tags.split(",")) {
          const trimmed = tag.trim();
          if (trimmed) tagSet.add(trimmed);
        }
      }

      const sorted = [...tagSet].sort();

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/plain",
            text:
              sorted.length > 0
                ? `# All Tags (${sorted.length})\n\n${sorted.join(", ")}`
                : "No tags found. Create notes or bookmarks with tags first.",
          },
        ],
      };
    }
  );

  server.resource(
    "kb-stats",
    "robin://kb/stats",
    { description: "Knowledge base statistics" },
    async (uri) => {
      const db = getDb();

      const noteCount = (
        db.prepare("SELECT COUNT(*) as count FROM notes").get() as {
          count: number;
        }
      ).count;
      const bookmarkCount = (
        db.prepare("SELECT COUNT(*) as count FROM bookmarks").get() as {
          count: number;
        }
      ).count;

      const recentNotes = db
        .prepare(
          "SELECT id, title, updated_at FROM notes ORDER BY updated_at DESC LIMIT 5"
        )
        .all() as Array<{ id: number; title: string; updated_at: string }>;

      const recentBookmarks = db
        .prepare(
          "SELECT id, title, created_at FROM bookmarks ORDER BY created_at DESC LIMIT 5"
        )
        .all() as Array<{ id: number; title: string; created_at: string }>;

      let text = `# Knowledge Base Stats\n\n`;
      text += `Notes: ${noteCount}\nBookmarks: ${bookmarkCount}\n`;

      if (recentNotes.length > 0) {
        text += `\n## Recent Notes\n`;
        for (const n of recentNotes) {
          text += `- [${n.id}] ${n.title} (${n.updated_at})\n`;
        }
      }

      if (recentBookmarks.length > 0) {
        text += `\n## Recent Bookmarks\n`;
        for (const b of recentBookmarks) {
          text += `- [${b.id}] ${b.title} (${b.created_at})\n`;
        }
      }

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/plain",
            text,
          },
        ],
      };
    }
  );
}
