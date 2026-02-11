import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { config } from "./config.js";
import { initAnalyticsSchema } from "./analytics/schema.js";

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = path.resolve(config.dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);
  return db;
}

/**
 * Renumber all rules in a context to sequential 1..N priorities.
 */
export function compactPriorities(db: Database.Database, context: string): void {
  const rules = db
    .prepare("SELECT id FROM source_rules WHERE context = ? ORDER BY priority")
    .all(context) as Array<{ id: number }>;

  const update = db.prepare("UPDATE source_rules SET priority = ? WHERE id = ?");
  const compact = db.transaction(() => {
    rules.forEach((rule, i) => {
      update.run(i + 1, rule.id);
    });
  });
  compact();
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tools TEXT NOT NULL DEFAULT '',
      resources TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS source_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL DEFAULT 1,
      reason TEXT NOT NULL DEFAULT '',
      UNIQUE(context, source_id)
    );

    CREATE TABLE IF NOT EXISTS contexts (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT ''
    );
  `);

  // Indexes for common query ordering
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON bookmarks(created_at);
  `);

  // Migration: add UNIQUE(context, priority) constraint to source_rules if missing
  migrateSourceRulesConstraint(db);

  initAnalyticsSchema(db);

  seedDefaultSources(db);
  seedDefaultContexts(db);
  migrateRemoveStaleSourcesV1(db);

  // FTS5 virtual table for full-text search on notes
  const ftsExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='notes_fts'"
    )
    .get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        title,
        content,
        tags,
        content='notes',
        content_rowid='id'
      );

      -- Populate FTS from existing data
      INSERT INTO notes_fts(rowid, title, content, tags)
        SELECT id, title, content, tags FROM notes;

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content, tags)
          VALUES (new.id, new.title, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
          VALUES ('delete', old.id, old.title, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
          VALUES ('delete', old.id, old.title, old.content, old.tags);
        INSERT INTO notes_fts(rowid, title, content, tags)
          VALUES (new.id, new.title, new.content, new.tags);
      END;
    `);
  }
}

function migrateSourceRulesConstraint(db: Database.Database): void {
  const tableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='source_rules'")
    .get() as { sql: string } | undefined;

  if (!tableInfo) return;

  // Check if the UNIQUE(context, priority) constraint already exists
  if (tableInfo.sql.includes("UNIQUE(context, priority)")) return;

  const migrate = db.transaction(() => {
    // Compact priorities first to ensure no conflicts
    const ctxRows = db
      .prepare("SELECT DISTINCT context FROM source_rules")
      .all() as Array<{ context: string }>;
    for (const { context } of ctxRows) {
      compactPriorities(db, context);
    }

    db.exec(`
      CREATE TABLE source_rules_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        priority INTEGER NOT NULL DEFAULT 1,
        reason TEXT NOT NULL DEFAULT '',
        UNIQUE(context, source_id),
        UNIQUE(context, priority)
      );
      INSERT INTO source_rules_new (id, context, source_id, priority, reason)
        SELECT id, context, source_id, priority, reason FROM source_rules;
      DROP TABLE source_rules;
      ALTER TABLE source_rules_new RENAME TO source_rules;
    `);
  });
  migrate();
}

function seedDefaultContexts(db: Database.Database): void {
  const existing = db.prepare("SELECT COUNT(*) as count FROM contexts").get() as { count: number };
  if (existing.count > 0) return;

  const insert = db.prepare("INSERT OR IGNORE INTO contexts (name, description) VALUES (?, ?)");
  const seed = db.transaction(() => {
    insert.run("code", "Context for writing, reviewing, or analyzing application code and engineering topics");
    insert.run("project-management", "Tracking issues, sprints, and team work via Linear and related tools");
    insert.run("creative-writing", "Fiction writing, story development, and creative composition");
    insert.run("static-drift", "The Static Drift speculative fiction universe — worldbuilding, stories, and lore");
    insert.run("personal-brand", "Public web presence, published writing, and professional profile");
    insert.run("research", "Research notes, references, and information gathering");
    insert.run("general", "Catch-all context for general knowledge queries and tasks");
  });
  seed();
}

/**
 * Remove sources that are redundant or lack a good data source.
 * - writings-static-drift: all content is in the Creative Vault
 * - tom-cannon-research: Liverpool Uni page is too heavy; will re-add when a better source is found
 */
function migrateRemoveStaleSourcesV1(db: Database.Database): void {
  const staleIds = ["writings-static-drift", "tom-cannon-research"];
  const existing = db
    .prepare(`SELECT id FROM sources WHERE id IN (${staleIds.map(() => "?").join(",")})`)
    .all(...staleIds) as Array<{ id: string }>;

  if (existing.length === 0) return;

  const migrate = db.transaction(() => {
    for (const { id } of existing) {
      const contexts = db
        .prepare("SELECT DISTINCT context FROM source_rules WHERE source_id = ?")
        .all(id) as Array<{ context: string }>;

      db.prepare("DELETE FROM source_rules WHERE source_id = ?").run(id);
      db.prepare("DELETE FROM sources WHERE id = ?").run(id);

      for (const { context } of contexts) {
        compactPriorities(db, context);
      }

      console.error(`[db] Removed stale source: ${id}`);
    }
  });
  migrate();
}

function seedDefaultSources(db: Database.Database): void {
  const existing = db.prepare("SELECT COUNT(*) as count FROM sources").get() as { count: number };
  if (existing.count > 0) return;

  const insertSource = db.prepare(
    "INSERT OR IGNORE INTO sources (id, name, description, tools, resources) VALUES (?, ?, ?, ?, ?)"
  );
  const insertRule = db.prepare(
    "INSERT OR IGNORE INTO source_rules (context, source_id, priority, reason) VALUES (?, ?, ?, ?)"
  );

  const seed = db.transaction(() => {
    // Sources
    insertSource.run("kb-notes", "Knowledge Base Notes", "Personal notes with full-text search", "create-note,search-notes,get-note,update-note,delete-note", "robin://kb/tags,robin://kb/stats");
    insertSource.run("kb-bookmarks", "Knowledge Base Bookmarks", "Saved URLs and references", "save-bookmark,search-bookmarks,delete-bookmark", "");
    insertSource.run("writings", "Personal Writings", "Website, blog posts, and LinkedIn profile", "", "robin://writings/website,robin://writings/blog-posts,robin://writings/linkedin,robin://writings/shiny-toy-robots,robin://writings/alternate-frequencies");
    insertSource.run("github", "GitHub", "GitHub repo search and API access", "github-search-repos,http-fetch", "");
    insertSource.run("vault", "Creative Vault", "StaticDrift fiction universe - private creative writing repo", "vault-read-file,vault-list-dir", "robin://vault/structure");
    insertSource.run("linear", "Linear", "Project management - issues, teams, assignments", "linear-search-issues,linear-get-issue,linear-my-issues,linear-create-issue", "robin://linear/teams");

    // Contextual rules (priority: 1 = most preferred)
    // Code & engineering
    insertRule.run("code", "github", 1, "GitHub is the primary source for code, repos, and open-source references");
    insertRule.run("code", "kb-bookmarks", 2, "Bookmarks may contain saved technical references");
    insertRule.run("code", "kb-notes", 3, "Notes may contain code snippets or technical decisions");

    // Project management & work
    insertRule.run("project-management", "linear", 1, "Linear is the source of truth for issues, sprints, and team work");
    insertRule.run("project-management", "kb-notes", 2, "Notes may contain meeting notes or project context");

    // Writing & creative
    insertRule.run("creative-writing", "vault", 1, "The creative vault is the primary source for fiction and creative work");
    insertRule.run("creative-writing", "writings", 2, "Shiny Toy Robots and Alternate Frequencies sections contain published creative writing");
    insertRule.run("creative-writing", "kb-notes", 3, "Notes may contain story ideas or writing drafts");

    // Static Drift universe specifically
    insertRule.run("static-drift", "vault", 1, "The StaticDrift folder in the creative vault is the canonical source for the Static Drift universe");
    insertRule.run("static-drift", "writings", 2, "Shiny Toy Robots and Alternate Frequencies may contain related creative pieces");
    insertRule.run("static-drift", "kb-notes", 3, "Notes may contain world-building ideas or story planning");

    // Personal brand & public content
    insertRule.run("personal-brand", "writings", 1, "Website and blog are the canonical public presence");
    insertRule.run("personal-brand", "kb-bookmarks", 2, "Bookmarks may track published content or press");

    // Research & reference
    insertRule.run("research", "kb-notes", 1, "Notes are the primary place to store research findings");
    insertRule.run("research", "kb-bookmarks", 2, "Bookmarks save reference material");
    insertRule.run("research", "github", 3, "GitHub repos can be research references");

    // General / catch-all
    insertRule.run("general", "kb-notes", 1, "Notes are the most versatile knowledge store");
    insertRule.run("general", "kb-bookmarks", 2, "Bookmarks provide quick references");
    insertRule.run("general", "linear", 3, "Linear provides work context");
  });

  seed();
}
