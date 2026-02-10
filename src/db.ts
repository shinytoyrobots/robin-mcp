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
  `);

  initAnalyticsSchema(db);

  seedDefaultSources(db);

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
    insertSource.run("writings-static-drift", "Static Drift (Website)", "Published Static Drift fiction and posts tagged 'staticdrift' on robin-cannon.com", "", "robin://writings/static-drift");
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
    insertRule.run("static-drift", "writings-static-drift", 2, "Published Static Drift posts on robin-cannon.com tagged 'staticdrift'");
    insertRule.run("static-drift", "writings", 3, "Shiny Toy Robots and Alternate Frequencies may contain related creative pieces");
    insertRule.run("static-drift", "kb-notes", 4, "Notes may contain world-building ideas or story planning");

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
