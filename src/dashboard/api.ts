import { Router } from "express";
import type { Request, Response } from "express";
import { getDb, compactPriorities } from "../db.js";
import { invalidateRoutingCache } from "../tools/sources.js";

export function createApiRouter(
  sessions: Map<string, unknown>,
): Router {
  const router = Router();

  // GET /api/stats — aggregated usage stats (single scan + two grouped queries)
  router.get("/stats", (req: Request, res: Response) => {
    const db = getDb();
    const period = (req.query.period as string) || "7d";

    const periodSql = periodToSql(period);

    // Single scan for all scalar aggregates
    const summary = db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
           AVG(duration_ms) as avg_ms,
           SUM(token_estimate) as tokens
         FROM tool_calls WHERE called_at >= datetime('now', ?)`,
      )
      .get(periodSql) as {
      total: number;
      successes: number;
      avg_ms: number | null;
      tokens: number | null;
    };

    const topTools = db
      .prepare(
        `SELECT tool_name, COUNT(*) as calls, AVG(duration_ms) as avg_ms
         FROM tool_calls WHERE called_at >= datetime('now', ?)
         GROUP BY tool_name ORDER BY calls DESC LIMIT 20`,
      )
      .all(periodSql) as Array<{
      tool_name: string;
      calls: number;
      avg_ms: number | null;
    }>;

    const sourceBreakdown = db
      .prepare(
        `SELECT COALESCE(source_id, 'unknown') as source_id, COUNT(*) as calls
         FROM tool_calls WHERE called_at >= datetime('now', ?)
         GROUP BY source_id ORDER BY calls DESC`,
      )
      .all(periodSql) as Array<{ source_id: string; calls: number }>;

    res.json({
      period,
      totalCalls: summary.total,
      successRate:
        summary.total > 0
          ? Math.round((summary.successes / summary.total) * 100)
          : 100,
      avgDurationMs: Math.round(summary.avg_ms ?? 0),
      estimatedTokens: summary.tokens ?? 0,
      topTools,
      sourceBreakdown,
    });
  });

  // GET /api/tools — paginated tool call log
  router.get("/tools", (req: Request, res: Response) => {
    const db = getDb();
    const tool = req.query.tool as string | undefined;
    const source = req.query.source as string | undefined;
    const status = req.query.status as string | undefined;
    const period = (req.query.period as string) || "7d";
    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt((req.query.limit as string) || "50", 10)),
    );
    const offset = (page - 1) * limit;

    const periodSql = periodToSql(period);
    const conditions: string[] = [`called_at >= datetime('now', ?)`];
    const params: unknown[] = [periodSql];

    if (tool) {
      conditions.push("tool_name = ?");
      params.push(tool);
    }
    if (source) {
      conditions.push("source_id = ?");
      params.push(source);
    }
    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }

    const where = conditions.join(" AND ");
    const countRow = db
      .prepare(`SELECT COUNT(*) as count FROM tool_calls WHERE ${where}`)
      .get(...params) as { count: number };

    const rows = db
      .prepare(
        `SELECT * FROM tool_calls WHERE ${where} ORDER BY called_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    res.json({
      total: countRow.count,
      page,
      limit,
      data: rows,
    });
  });

  // GET /api/health — adapter health
  router.get("/health", (_req: Request, res: Response) => {
    const db = getDb();

    // Latest status per adapter
    const latest = db
      .prepare(
        `SELECT ah.* FROM adapter_health ah
         INNER JOIN (
           SELECT adapter_id, MAX(checked_at) as max_checked
           FROM adapter_health GROUP BY adapter_id
         ) latest ON ah.adapter_id = latest.adapter_id AND ah.checked_at = latest.max_checked
         ORDER BY ah.adapter_id`,
      )
      .all();

    // Recent history (last 20 per adapter)
    const history = db
      .prepare(
        `SELECT * FROM adapter_health ORDER BY checked_at DESC LIMIT 100`,
      )
      .all();

    res.json({ latest, history });
  });

  // GET /api/routing — all source rules (2 queries: rules+sources join, contexts)
  router.get("/routing", (_req: Request, res: Response) => {
    const db = getDb();

    // Single query: rules joined with source names, plus a separate lightweight contexts query
    const rules = db
      .prepare(
        `SELECT sr.*, s.name as source_name
         FROM source_rules sr
         JOIN sources s ON s.id = sr.source_id
         ORDER BY sr.context, sr.priority`,
      )
      .all() as Array<{
      id: number;
      context: string;
      source_id: string;
      priority: number;
      reason: string;
      source_name: string;
    }>;

    // Collect unique source ids/names from rules + all sources for the dropdown
    const sources = db
      .prepare("SELECT id, name FROM sources ORDER BY name")
      .all();

    const ctxDescs = db
      .prepare("SELECT name, description FROM contexts")
      .all() as Array<{ name: string; description: string }>;

    const contextDescriptions: Record<string, string> = {};
    for (const c of ctxDescs) {
      contextDescriptions[c.name] = c.description;
    }

    // Group by context
    const grouped: Record<
      string,
      Array<{
        id: number;
        source_id: string;
        source_name: string;
        priority: number;
        reason: string;
      }>
    > = {};
    for (const rule of rules) {
      if (!grouped[rule.context]) grouped[rule.context] = [];
      grouped[rule.context].push({
        id: rule.id,
        source_id: rule.source_id,
        source_name: rule.source_name,
        priority: rule.priority,
        reason: rule.reason,
      });
    }

    // Find sources with no routing rules
    const routedSourceIds = new Set(rules.map(r => r.source_id));
    const unroutedSources = (sources as Array<{ id: string; name: string }>)
      .filter(s => !routedSourceIds.has(s.id));

    res.json({ contexts: grouped, sources, contextDescriptions, unroutedSources });
  });

  // PUT /api/routing — update a rule (full access only)
  router.put("/routing", (req: Request, res: Response) => {
    if (req.dashboardAccess !== "full") {
      res.status(403).json({ error: "Full access required" });
      return;
    }

    const { context, sourceId, reason } = req.body as {
      context: string;
      sourceId: string;
      reason: string;
    };

    if (!context || !sourceId || !reason) {
      res
        .status(400)
        .json({ error: "Missing required fields: context, sourceId, reason" });
      return;
    }

    const db = getDb();

    // Verify source exists
    const source = db
      .prepare("SELECT id FROM sources WHERE id = ?")
      .get(sourceId);
    if (!source) {
      res.status(404).json({ error: `Source "${sourceId}" not found` });
      return;
    }

    // Check if rule already exists
    const existing = db
      .prepare("SELECT id FROM source_rules WHERE context = ? AND source_id = ?")
      .get(context, sourceId);

    if (existing) {
      // Update reason only, keep priority
      db.prepare("UPDATE source_rules SET reason = ? WHERE context = ? AND source_id = ?")
        .run(reason, context, sourceId);
    } else {
      // New rule: assign priority = max + 1
      const maxRow = db
        .prepare("SELECT COALESCE(MAX(priority), 0) as max_p FROM source_rules WHERE context = ?")
        .get(context) as { max_p: number };
      const newPriority = maxRow.max_p + 1;

      db.prepare(
        "INSERT INTO source_rules (context, source_id, priority, reason) VALUES (?, ?, ?, ?)",
      ).run(context, sourceId, newPriority, reason);

      // Auto-create context entry if new
      db.prepare("INSERT OR IGNORE INTO contexts (name, description) VALUES (?, '')").run(context);
    }

    invalidateRoutingCache();
    res.json({ ok: true });
  });

  // DELETE /api/routing — delete a rule (full access only)
  router.delete("/routing", (req: Request, res: Response) => {
    if (req.dashboardAccess !== "full") {
      res.status(403).json({ error: "Full access required" });
      return;
    }

    const { context, sourceId } = req.body as {
      context: string;
      sourceId: string;
    };

    if (!context || !sourceId) {
      res
        .status(400)
        .json({ error: "Missing required fields: context, sourceId" });
      return;
    }

    const db = getDb();
    const result = db
      .prepare("DELETE FROM source_rules WHERE context = ? AND source_id = ?")
      .run(context, sourceId);

    if (result.changes === 0) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }

    compactPriorities(db, context);
    invalidateRoutingCache();
    res.json({ ok: true });
  });

  // POST /api/routing/reorder — reorder rules within a context
  router.post("/routing/reorder", (req: Request, res: Response) => {
    if (req.dashboardAccess !== "full") {
      res.status(403).json({ error: "Full access required" });
      return;
    }

    const { context, sourceIds } = req.body as {
      context: string;
      sourceIds: string[];
    };

    if (!context || !Array.isArray(sourceIds) || sourceIds.length === 0) {
      res.status(400).json({ error: "Missing required fields: context, sourceIds" });
      return;
    }

    const db = getDb();

    // Validate sourceIds matches existing rules exactly
    const existingRules = db
      .prepare("SELECT source_id FROM source_rules WHERE context = ? ORDER BY priority")
      .all(context) as Array<{ source_id: string }>;

    const existingIds = existingRules.map(r => r.source_id).sort();
    const requestedIds = [...sourceIds].sort();

    if (existingIds.length !== requestedIds.length || !existingIds.every((id, i) => id === requestedIds[i])) {
      res.status(400).json({ error: "sourceIds must match exactly the existing sources for this context" });
      return;
    }

    // Check for duplicates in request
    if (new Set(sourceIds).size !== sourceIds.length) {
      res.status(400).json({ error: "sourceIds must not contain duplicates" });
      return;
    }

    // Use temporary negative priorities to avoid UNIQUE constraint conflicts, then assign 1..N
    const reorder = db.transaction(() => {
      const setNeg = db.prepare("UPDATE source_rules SET priority = ? WHERE context = ? AND source_id = ?");
      const setPos = db.prepare("UPDATE source_rules SET priority = ? WHERE context = ? AND source_id = ?");

      // Step 1: Set all to negative temporaries
      sourceIds.forEach((sid, i) => {
        setNeg.run(-(i + 1), context, sid);
      });

      // Step 2: Set to final 1..N
      sourceIds.forEach((sid, i) => {
        setPos.run(i + 1, context, sid);
      });
    });

    reorder();
    invalidateRoutingCache();
    res.json({ ok: true });
  });

  // PUT /api/contexts/:name — upsert context description
  router.put("/contexts/:name", (req: Request, res: Response) => {
    if (req.dashboardAccess !== "full") {
      res.status(403).json({ error: "Full access required" });
      return;
    }

    const name = req.params.name;
    const { description } = req.body as { description: string };

    if (description == null) {
      res.status(400).json({ error: "Missing required field: description" });
      return;
    }

    const db = getDb();
    db.prepare(
      `INSERT INTO contexts (name, description) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET description = ?`,
    ).run(name, description, description);

    invalidateRoutingCache();
    res.json({ ok: true });
  });

  // POST /api/routing/preview — preview routing for a context
  router.post("/routing/preview", (req: Request, res: Response) => {
    const { context } = req.body as { context: string };
    if (!context) {
      res.status(400).json({ error: "Missing required field: context" });
      return;
    }

    const db = getDb();
    let rules = db
      .prepare(
        `SELECT sr.*, s.name, s.tools, s.resources
         FROM source_rules sr
         JOIN sources s ON s.id = sr.source_id
         WHERE sr.context = ?
         ORDER BY sr.priority`,
      )
      .all(context) as Array<{
      context: string;
      source_id: string;
      priority: number;
      reason: string;
      name: string;
      tools: string;
      resources: string;
    }>;

    // Get context description
    const ctxDesc = db
      .prepare("SELECT description FROM contexts WHERE name = ?")
      .get(context) as { description: string } | undefined;

    // Fall back to general
    if (rules.length === 0) {
      rules = db
        .prepare(
          `SELECT sr.*, s.name, s.tools, s.resources
           FROM source_rules sr
           JOIN sources s ON s.id = sr.source_id
           WHERE sr.context = 'general'
           ORDER BY sr.priority`,
        )
        .all() as typeof rules;
    }

    res.json({
      context,
      description: ctxDesc?.description || "",
      fallback: rules.length > 0 && rules[0].context !== context,
      rules: rules.map((r) => ({
        source_id: r.source_id,
        source_name: r.name,
        priority: r.priority,
        reason: r.reason,
        tools: r.tools,
        resources: r.resources,
      })),
    });
  });

  // GET /api/sessions — active session count
  router.get("/sessions", (_req: Request, res: Response) => {
    res.json({ active: sessions.size });
  });

  return router;
}

function periodToSql(period: string): string {
  switch (period) {
    case "24h":
      return "-1 day";
    case "7d":
      return "-7 days";
    case "30d":
      return "-30 days";
    case "all":
      return "-100 years";
    default:
      return "-7 days";
  }
}
