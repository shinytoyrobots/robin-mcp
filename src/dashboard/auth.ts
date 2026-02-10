import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

declare global {
  namespace Express {
    interface Request {
      dashboardAccess?: "full" | "readonly";
    }
  }
}

export function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const queryToken = req.query.token as string | undefined;
  const bearerToken = req.headers.authorization;
  const cfAccess = req.headers["cf-access-authenticated-user-email"];
  const cookieHeader = req.headers.cookie ?? "";
  const cookieToken = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("robin_token="))
    ?.split("=")[1];

  const token = queryToken || cookieToken || (bearerToken?.startsWith("Bearer ") ? bearerToken.slice(7) : undefined);

  // Full access
  if (config.authToken && token === config.authToken) {
    req.dashboardAccess = "full";
    next();
    return;
  }

  // Read-only token
  if (config.readonlyToken && token === config.readonlyToken) {
    req.dashboardAccess = "readonly";
    next();
    return;
  }

  // Cloudflare Access (read-only)
  if (cfAccess) {
    req.dashboardAccess = "readonly";
    next();
    return;
  }

  // No auth configured = open full access (local dev)
  if (!config.authToken && !config.readonlyToken) {
    req.dashboardAccess = "full";
    next();
    return;
  }

  // Not authenticated — redirect HTML requests to login, reject API with 401
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "Unauthorized" });
  } else {
    res.redirect("/dashboard/login");
  }
}
