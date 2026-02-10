import { Router } from "express";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dashboardAuth } from "./auth.js";
import { createApiRouter } from "./api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cache views at startup — they don't change at runtime
const viewCache = new Map<string, string>();
function readView(name: string): string {
  let html = viewCache.get(name);
  if (!html) {
    const viewsDir = path.resolve(__dirname, "views");
    html = fs.readFileSync(path.join(viewsDir, name), "utf-8");
    viewCache.set(name, html);
  }
  return html;
}

export function createDashboardRouter(
  sessions: Map<string, unknown>,
): Router {
  const router = Router();

  // Static assets (CSS) — public, no auth required
  router.use(
    "/assets",
    express.static(path.resolve(__dirname, "views"), { maxAge: "1h" }),
  );

  // Login page is public (no auth middleware)
  router.get("/login", (_req, res) => {
    res.type("html").send(readView("login.html"));
  });

  // Auth middleware for everything else
  router.use(dashboardAuth);

  // HTML pages
  router.get("/", (_req, res) => {
    res.type("html").send(readView("dashboard.html"));
  });

  router.get("/routing", (req, res) => {
    res.type("html").send(readView("routing.html"));
  });

  // API endpoints
  router.use("/api", createApiRouter(sessions));

  return router;
}
