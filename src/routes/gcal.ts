import { Router } from "express";
import { config } from "../config.js";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: CachedToken | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const params = new URLSearchParams({
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    refresh_token: config.googleRefreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.accessToken;
}

type CalendarListItem = {
  id: string;
  summary: string;
  hidden?: boolean;
};

export function createGcalRouter(): Router {
  const router = Router();

  router.get("/calendars", async (_req, res) => {
    try {
      const token = await getAccessToken();
      const gcalRes = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!gcalRes.ok) {
        const err = await gcalRes.text();
        res.status(gcalRes.status).json({ error: err });
        return;
      }
      const data = (await gcalRes.json()) as { items: unknown[] };
      res.json({ calendars: data.items });
    } catch (err) {
      console.error("gcal/calendars error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  router.get("/events", async (req, res) => {
    try {
      const token = await getAccessToken();
      const now = new Date();
      const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const timeMin = now.toISOString();
      const timeMax = sevenDays.toISOString();
      const calId = req.query.cal as string | undefined;

      if (calId === "all") {
        const listRes = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!listRes.ok) {
          const err = await listRes.text();
          res.status(listRes.status).json({ error: err });
          return;
        }
        const listData = (await listRes.json()) as { items: CalendarListItem[] };
        const calendars = listData.items.filter((c) => !c.hidden);

        const allEvents: unknown[] = [];
        await Promise.all(
          calendars.map(async (cal) => {
            const evRes = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` +
                new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime" }),
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (evRes.ok) {
              const evData = (await evRes.json()) as { items: unknown[] };
              allEvents.push(...(evData.items || []));
            }
          })
        );
        res.json({ events: allEvents });
      } else {
        const targetCal = calId || "primary";
        const evRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCal)}/events?` +
            new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime" }),
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!evRes.ok) {
          const err = await evRes.text();
          res.status(evRes.status).json({ error: err });
          return;
        }
        const evData = (await evRes.json()) as { items: unknown[] };
        res.json({ events: evData.items });
      }
    } catch (err) {
      console.error("gcal/events error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
