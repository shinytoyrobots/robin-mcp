import { getDb } from "../db.js";
import { config } from "../config.js";

export interface ToolCallLog {
  toolName: string;
  sourceId: string | null;
  authLevel: string;
  status: "success" | "error";
  durationMs: number;
  requestSize: number;
  responseSize: number;
  errorMessage?: string;
}

export interface AdapterHealthLog {
  adapterId: string;
  status: "up" | "down";
  initDurationMs: number;
  toolCount?: number;
  resourceCount?: number;
  errorMessage?: string;
}

// Cache: tool name → source ID
let sourceMap: Map<string, string> | null = null;

export function resolveSourceId(toolName: string): string | null {
  if (!sourceMap) {
    sourceMap = new Map();
    const db = getDb();
    const sources = db
      .prepare("SELECT id, tools FROM sources WHERE tools != ''")
      .all() as Array<{ id: string; tools: string }>;

    for (const source of sources) {
      for (const tool of source.tools.split(",")) {
        const trimmed = tool.trim();
        if (trimmed) sourceMap.set(trimmed, source.id);
      }
    }
  }
  return sourceMap.get(toolName) ?? null;
}

export function invalidateSourceCache(): void {
  sourceMap = null;
}

export function logToolCall(data: ToolCallLog): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO tool_calls (tool_name, source_id, auth_level, status, duration_ms, request_size, response_size, token_estimate, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.toolName,
    data.sourceId,
    data.authLevel,
    data.status,
    data.durationMs,
    data.requestSize,
    data.responseSize,
    Math.round(data.responseSize / 4),
    data.errorMessage ?? null,
  );
}

export function logAdapterHealth(data: AdapterHealthLog): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO adapter_health (adapter_id, status, init_duration_ms, tool_count, resource_count, error_message)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    data.adapterId,
    data.status,
    data.initDurationMs,
    data.toolCount ?? null,
    data.resourceCount ?? null,
    data.errorMessage ?? null,
  );
}

export function pruneOldAnalytics(): void {
  const days = config.analyticsRetentionDays;
  const db = getDb();
  db.prepare(
    `DELETE FROM tool_calls WHERE called_at < datetime('now', ?)`,
  ).run(`-${days} days`);
  db.prepare(
    `DELETE FROM adapter_health WHERE checked_at < datetime('now', ?)`,
  ).run(`-${days} days`);
}
